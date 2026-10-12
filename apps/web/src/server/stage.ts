import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db, getQueue, getTrack, setting, setSetting, transaction } from './db';
import { HttpError } from './auth';
import { STAGE_CONTROLLER, type StageAdminState, type StageDesired, type StageFeed, type StageReport } from '../lib/types';

export { STAGE_CONTROLLER };
export const LEASE_MS = 30000;
const CONNECTED_MS = 5000;

const micDefaults = { enabled: false, deviceId: '', mode: 'mix' as const, gain: 1, muted: false, monitor: false };
const DEFAULT_DESIRED: StageDesired = {
  trackId: null, singer: null, transportRev: 0, playing: false, position: 0,
  backingGain: 0.9, guideGain: 0, backingMuted: false, guideMuted: false,
  mics: [{ ...micDefaults }, { ...micDefaults }], showSinger: true, showNextUp: true,
};

const micSchema = z.object({
  enabled: z.boolean(), deviceId: z.string().max(500), mode: z.enum(['mix', 'left', 'right', 'stereo']),
  gain: z.number().min(0).max(2), muted: z.boolean(), monitor: z.boolean(),
}).partial().strict();
const mixSchema = z.object({
  backingGain: z.number().min(0).max(1.5), guideGain: z.number().min(0).max(1.5), backingMuted: z.boolean(), guideMuted: z.boolean(),
  showSinger: z.boolean(), showNextUp: z.boolean(), mics: z.tuple([micSchema, micSchema]),
}).partial().strict();
export const stageActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('load'), trackId: z.string(), singer: z.string().trim().max(100).optional(), entryId: z.string().optional() }),
  z.object({ action: z.literal('play') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('seek'), position: z.number().min(0).max(24 * 3600) }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('mix'), mix: mixSchema }),
  z.object({ action: z.literal('rotateKey') }),
]);
const reportSchema = z.object({
  trackId: z.string().max(100).nullable(),
  transport: z.enum(['idle', 'loading', 'ready', 'playing', 'paused', 'ended', 'error']),
  position: z.number().min(0).max(24 * 3600), duration: z.number().min(0).max(24 * 3600), loadProgress: z.number().min(0).max(1),
  error: z.string().max(1000).nullable(), hasGuide: z.boolean(), soundBlocked: z.boolean(), micSupported: z.boolean().nullable(),
  devices: z.array(z.object({ deviceId: z.string().max(500), label: z.string().max(300) })).max(64),
  mics: z.array(z.object({ status: z.enum(['off', 'starting', 'on', 'error']), error: z.string().max(1000).nullable(), label: z.string().max(300).nullable() })).max(2),
});

function readJson<T>(key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(setting(key) || 'null') }; } catch { return fallback; }
}
export const desired = (): StageDesired => readJson('stage_desired', DEFAULT_DESIRED);
const saveDesired = (d: StageDesired) => setSetting('stage_desired', JSON.stringify(d));
const report = (): StageReport | null => { const r = readJson<StageReport | null>('stage_report', null); return r?.at ? r : null; };
const connected = (r: StageReport | null) => !!r && r.at > Date.now() - CONNECTED_MS;

export function stageKey(): string {
  let key = setting('stage_key');
  if (!key) { key = randomBytes(18).toString('base64url'); setSetting('stage_key', key); }
  return key;
}
export function requireStageKey(request: Request) {
  const given = Buffer.from(request.headers.get('x-stage-key') || '');
  const expected = Buffer.from(stageKey());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'This stage display is not paired. Open the stage link from the host’s Stage tab again.');
}

type Lease = { trackId: string; controller: string; expiresAt: number; owner: string };
function lease(): Lease | null {
  try { const l = JSON.parse(setting('active_session') || 'null') as Lease | null; return l && l.expiresAt > Date.now() ? l : null; } catch { return null; }
}
const stageLease = (trackId: string) => setSetting('active_session', JSON.stringify({ trackId, controller: STAGE_CONTROLLER, expiresAt: Date.now() + LEASE_MS, owner: STAGE_CONTROLLER }));

/** Where the stage most likely is now, from its last report. */
function estimatedPosition(d: StageDesired, r: StageReport | null) {
  if (!r || r.trackId !== d.trackId || r.transport === 'loading' || r.transport === 'idle') return d.position;
  if (r.transport === 'ended') return r.duration;
  const moving = r.transport === 'playing' ? (Date.now() - r.at) / 1000 : 0;
  return Math.min(r.duration || Infinity, r.position + moving);
}

function nextUp(): string | null {
  const first = getQueue()[0];
  if (!first) return null;
  const track = getTrack(first.trackId);
  return `${first.singer}${track ? `, ${track.title}` : ''}`;
}

export function adminStageState(): StageAdminState {
  const r = report();
  return { desired: desired(), report: r, connected: connected(r), key: stageKey(), now: Date.now() };
}

export function stageAction(input: z.infer<typeof stageActionSchema>) {
  transaction(() => {
    const d = desired();
    const r = report();
    switch (input.action) {
      case 'load': {
        const track = getTrack(input.trackId);
        if (!track || track.status !== 'ready') throw new HttpError(400, 'Choose a prepared song.');
        if (!connected(r)) throw new HttpError(409, 'The stage display is not connected. Open the KaraokeThing Stage app, or the stage link, on the main screen.');
        const current = lease();
        if (current && current.controller !== STAGE_CONTROLLER) throw new HttpError(409, 'A browser is playing a song right now. Stop it there first.');
        const entry = input.entryId ? getQueue().find((e) => e.id === input.entryId) : undefined;
        if (entry) db.prepare('DELETE FROM queue WHERE id=?').run(entry.id);
        saveDesired({ ...d, trackId: track.id, singer: entry?.singer ?? input.singer ?? null, playing: true, position: 0, transportRev: d.transportRev + 1 });
        stageLease(track.id);
        return;
      }
      case 'play':
      case 'pause': {
        if (!d.trackId) throw new HttpError(409, 'Nothing is loaded on the stage display.');
        const current = lease();
        if (input.action === 'play' && current && current.controller !== STAGE_CONTROLLER) throw new HttpError(409, 'A browser is playing a song right now. Stop it there first.');
        let position = estimatedPosition(d, r);
        if (input.action === 'play' && r?.transport === 'ended') position = 0;
        saveDesired({ ...d, playing: input.action === 'play', position, transportRev: d.transportRev + 1 });
        if (input.action === 'play') stageLease(d.trackId);
        return;
      }
      case 'seek':
        if (!d.trackId) throw new HttpError(409, 'Nothing is loaded on the stage display.');
        saveDesired({ ...d, playing: r?.transport === 'ended' ? false : d.playing, position: input.position, transportRev: d.transportRev + 1 });
        return;
      case 'stop':
        saveDesired({ ...d, trackId: null, singer: null, playing: false, position: 0, transportRev: d.transportRev + 1 });
        if (lease()?.controller === STAGE_CONTROLLER) setSetting('active_session', 'null');
        return;
      case 'mix': {
        const { mics, ...rest } = input.mix;
        saveDesired({ ...d, ...rest, mics: mics ? [{ ...d.mics[0], ...mics[0] }, { ...d.mics[1], ...mics[1] }] : d.mics });
        return;
      }
      case 'rotateKey':
        setSetting('stage_key', randomBytes(18).toString('base64url'));
        setSetting('stage_report', 'null');
        return;
    }
  });
}

/** The stage display reports what it is doing and gets back what it should do. */
export function stageReport(input: unknown): StageFeed {
  const r = reportSchema.parse(input);
  return transaction(() => {
    setSetting('stage_report', JSON.stringify({ ...r, at: Date.now() }));
    let d = desired();
    if (d.trackId) {
      const current = lease();
      // While the display was away, a browser took over playback: give way instead of playing on top of it.
      if (current && current.controller !== STAGE_CONTROLLER) {
        d = { ...d, trackId: null, singer: null, playing: false, position: 0, transportRev: d.transportRev + 1 };
        saveDesired(d);
      } else if (!getTrack(d.trackId)) {
        d = { ...d, trackId: null, singer: null, playing: false, position: 0, transportRev: d.transportRev + 1 };
        saveDesired(d);
        if (current) setSetting('active_session', 'null');
      } else if (r.transport !== 'ended') stageLease(d.trackId); // Like a browser, give the lease up once the song ends.
    }
    return { desired: d, nextUp: d.showNextUp ? nextUp() : null };
  });
}
