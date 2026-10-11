'use client';

import { useState } from 'react';
import { authAction } from '@/lib/client-api';
import { Input } from '@/components/ui/input';
import { ErrorNote } from './ui-bits';

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  // Which field an error belongs to, so it can be announced with that field.
  const [error, setError] = useState<{ text: string; field?: 'pw' | 'again' }>({ text: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) { setError({ text: 'Use at least 8 characters.', field: 'pw' }); return; }
    if (pw !== again) { setError({ text: 'The two passwords do not match.', field: 'again' }); return; }
    setBusy(true); setError({ text: '' });
    try { await authAction('setup', pw); onDone(); } catch (err) { setError({ text: msg(err), field: 'pw' }); setBusy(false); }
  };
  const errFor = (f: 'pw' | 'again') => (error.text && error.field === f ? { 'aria-invalid': true, 'aria-describedby': 'su-err' } : {});
  return (
    <main className="stage flex min-h-dvh items-center justify-center p-4">
      <div className="beam beam-a" aria-hidden /><div className="beam beam-b" aria-hidden /><div className="beam beam-c" aria-hidden />
      <form onSubmit={submit} className="panel w-full max-w-md space-y-4 p-6 backdrop-blur">
        <div>
          <h1 className="font-display text-5xl font-extrabold leading-none tracking-wide">Set up the host</h1>
          <p className="mt-2 text-sm text-muted-foreground">Create the one password that controls this library, queue, and playback. Everyone else on the network can browse but not change anything.</p>
        </div>
        <div><label className="lbl" htmlFor="su-pw">Host password</label><Input id="su-pw" type="password" className="field" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus {...errFor('pw')} /></div>
        <div><label className="lbl" htmlFor="su-pw2">Repeat password</label><Input id="su-pw2" type="password" className="field" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} {...errFor('again')} /></div>
        <ErrorNote id="su-err">{error.text}</ErrorNote>
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>Create password and continue</button>
      </form>
    </main>
  );
}

export function LoginForm({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await authAction('login', pw); onDone(); } catch (err) { setError(msg(err)); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div><label className="lbl" htmlFor="li-pw">Host password</label><Input id="li-pw" type="password" className="field" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus aria-invalid={!!error || undefined} aria-describedby={error ? 'li-err' : undefined} /></div>
      <ErrorNote id="li-err">{error}</ErrorNote>
      <button type="submit" className="btn btn-primary w-full" disabled={busy || !pw}>Sign in</button>
    </form>
  );
}
