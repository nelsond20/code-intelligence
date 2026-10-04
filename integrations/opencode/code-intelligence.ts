// CODE_INTELLIGENCE_MANAGED_PLUGIN
import { spawn } from 'node:child_process';

const MAX_CONTEXT_BYTES = 12_000;
const MAX_GUARD_BYTES = 16_000;
const TIMEOUT_MS = 3_000;

function readContext(directory: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value?: string) => {
      if (settled) return;
      settled = true;

      if (timer) {
        clearTimeout(timer);
      }

      resolve(value);
    };

    let child;

    try {
      child = spawn('code-intelligence', ['memory', 'context', '--workspace', 'planning', '--max-tokens', '3000'], {
        cwd: directory,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          GRAPHIFY_QUERY_LOG_DISABLE: '1',
          SERENA_USAGE_REPORTING: 'false',
          NO_COLOR: '1',
        },
      });
    } catch {
      finish();
      return;
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = MAX_CONTEXT_BYTES - capturedBytes;

      if (remaining <= 0) {
        return;
      }

      const value = Buffer.from(chunk).subarray(0, remaining);

      chunks.push(value);
      capturedBytes += value.length;
    });

    child.on('error', () => {
      finish();
    });

    child.on('close', (code) => {
      if (settled) return;

      const value = Buffer.concat(chunks).toString('utf8').trim();

      if (code === 0 && value.length > 0 && value !== 'No active memory.') {
        finish(value);
      } else {
        finish();
      }
    });

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Fail open.
      }

      finish();
    }, TIMEOUT_MS);
  });
}

function runGuard(directory: string, action: string, payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('code-intelligence', ['plan', action, '--workspace', 'planning'], {
      cwd: directory, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0;
    const capture = (target: Buffer[], chunk: Buffer) => { const value = Buffer.from(chunk).subarray(0, Math.max(0, MAX_GUARD_BYTES - bytes)); if (value.length) target.push(value); bytes += value.length; };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString('utf8') || '{}');
        if (code === 0) resolve(result);
        else reject(new Error(result.reason || Buffer.concat(stderr).toString('utf8').trim() || 'PlanGuard denied the operation'));
      } catch (error) { reject(error); }
    });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('PlanGuard timed out')); }, 5_000);
    child.stdin.end(JSON.stringify(payload));
  });
}

function mutationTargets(event: any): string[] {
  const direct = event.input?.filePath || event.input?.file_path || event.input?.path || event.input?.file;
  if (direct) return [String(direct)];
  const patch = event.input?.patchText || event.input?.patch || event.input?.diff;
  if (typeof patch !== 'string') return [];
  return [...patch.matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File:|\+\+\+ b\/)(.+)$/gm)].map((match) => match[1]!.trim());
}

const shellCommand = (event: any): string => typeof event.input?.command === 'string' ? event.input.command : typeof event.input?.code === 'string' ? event.input.code : '';
const exitCode = (event: any): unknown => event.result?.metadata?.exitCode ?? event.result?.metadata?.exit_code ?? event.result?.metadata?.exitStatus?.exitCode ??
  (event.result?.output?.ok === true ? 0 : event.result?.output?.ok === false ? 1 : undefined);

export default {
  id: 'code-intelligence',

  async setup(ctx: any) {
    try {
      try {
        const heartbeat = spawn('code-intelligence', ['integration', 'heartbeat', '--workspace', 'planning'], {
          cwd: ctx.location.directory, shell: false, stdio: 'ignore', env: { ...process.env, NO_COLOR: '1' },
        });
        heartbeat.unref();
      } catch { /* doctor will report a degraded guard */ }
      const registrations: Array<{ dispose(): Promise<void> }> = [];
      registrations.push(await ctx.session.hook('compaction', async (event: any) => {
        try {
          const state = await readContext(ctx.location.directory);

          if (!state) {
            return;
          }

          event.system.push({
            type: 'text',
            text: ['Code Intelligence persistent memory and active-plan state for this compaction.', 'Preserve its objective, phase, confirmed findings, active hypotheses,', 'open questions, blockers, relevant files/symbols, and compact current plan', 'when relevant.', '', state].join('\n'),
          });
        } catch {
          // Fail open: OpenCode continues normal compaction.
        }
      }));
      registrations.push(await ctx.tool.hook('execute.before', async (event: any) => {
        if (['edit', 'write', 'patch'].includes(event.tool)) {
          await runGuard(ctx.location.directory, 'guard-before', { kind: 'mutation', targets: mutationTargets(event) });
        } else if (event.tool === 'execute') {
          await runGuard(ctx.location.directory, 'guard-before', { kind: 'shell', command: shellCommand(event) });
        }
      }));
      registrations.push(await ctx.tool.hook('execute.after', async (event: any) => {
        if (event.status !== 'completed') return;
        if (['edit', 'write', 'patch'].includes(event.tool)) {
          await runGuard(ctx.location.directory, 'guard-after', { kind: 'mutation', targets: mutationTargets(event) });
        } else if (event.tool === 'execute' && Number.isInteger(exitCode(event))) {
          await runGuard(ctx.location.directory, 'guard-after', { kind: 'shell', command: shellCommand(event), exit_code: exitCode(event) });
        }
      }));

      return async () => {
        for (const registration of registrations) {
          try { await registration.dispose(); } catch {
            // Cleanup must not interfere with OpenCode shutdown.
          }
        }
      };
    } catch {
      // Plugin hook registration failure must not block OpenCode.
      return () => {};
    }
  },
};
