import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { z } from 'zod';
const port = z.number().int().min(1).max(65535);
const adapter = z.object({ enabled: z.boolean(), socket: z.string().min(1) });
export const configSchema = z.object({
 server: z.object({ host: z.string().min(1), port, public_host: z.string().min(1) }),
 database: z.object({ host: z.string().min(1), port, database: z.string().min(1), user: z.string().min(1), password: z.string().min(1) }),
 paths: z.object({ assets: z.string().min(1), web: z.string().min(1), run: z.string().min(1) }),
 adapters: z.object({ qq: adapter, telegram: adapter.extend({ api_id: z.number().nonnegative().refine(Number.isInteger), api_hash: z.string() }) }),
 log: z.object({ level: z.enum(['trace','debug','info','warn','error','fatal']) }),
 test: z.object({ probe_api: z.boolean(), probe_answer_inbound: z.boolean() })
});
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(path: string): Promise<Config> { return configSchema.parse(parse(await readFile(path, 'utf8'))); }
