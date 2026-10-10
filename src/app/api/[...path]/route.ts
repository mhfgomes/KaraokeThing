import { handleApi } from '@/server/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) { return handleApi(request, (await context.params).path); }
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE, handler as HEAD };
