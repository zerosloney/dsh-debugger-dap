/**
 * Adapter recipes: built-in DAP adapters (debugpy, dlv, netcoredbg,
 * lldb-dap, codelldb) plus config-declared rows, resolved against PATH
 * with actionable install hints. js-debug is intentionally config-only:
 * it ships as a TCP DAP server script rather than a PATH command.
 */
import { delimiter, isAbsolute, join } from 'node:path';
import { accessSync } from 'node:fs';
const BUILT_IN_RECIPES = [
    {
        id: 'debugpy',
        probeCommands: ['python', 'python3'],
        fixedArgs: ['-m', 'debugpy.adapter'],
        installHint: "adapter 'debugpy' is not available: install the debugpy module ('pip install debugpy') and ensure 'python' is on PATH",
        // debugpy 的异常过滤器是 raised/uncaught/userUnhandled，没有标准 DAP 的 'all'；
        // 把 'all' 映射为 'raised'（任何异常抛出即停），保持模型侧标准词汇。
        exceptionFilterMap: { all: 'raised' },
    },
    {
        id: 'dlv',
        probeCommands: ['dlv'],
        fixedArgs: ['dap'],
        installHint: "adapter 'dlv' is not available: install Delve ('go install github.com/go-delve/delve/cmd/dlv@latest') and ensure 'dlv' is on PATH",
    },
    {
        id: 'netcoredbg',
        probeCommands: ['netcoredbg'],
        fixedArgs: ['--interpreter=vscode'],
        installHint: "adapter 'netcoredbg' is not available: download a netcoredbg release from https://github.com/Samsung/netcoredbg/releases and ensure 'netcoredbg' is on PATH",
        // netcoredbg's launch config is `type: coreclr` and it controls the entry
        // stop via `stopAtEntry` rather than the standard `stopOnEntry`.
        launchArgs: { type: 'coreclr' },
        stopOnEntryKey: 'stopAtEntry',
    },
    {
        id: 'lldb-dap',
        probeCommands: ['lldb-dap', 'lldb-vscode', 'llvm-dap'],
        fixedArgs: [],
        installHint: "adapter 'lldb-dap' is not available: install the LLVM DAP binary (lldb-dap, lldb-vscode, or llvm-dap depending on your LLVM version) and ensure it is on PATH. On macOS with Xcode, you may need to build from https://llvm.org/git/dap.",
    },
    {
        id: 'codelldb',
        probeCommands: ['codelldb'],
        // Verified against upstream's clap Cli struct (src/codelldb/src/lib.rs):
        // only long options exist (--port/--connect/--liblldb/...), no positional
        // argument and no subcommand — an extra 'dap' would make the binary exit
        // with a usage error before listening.
        fixedArgs: ['--port', '0'],
        installHint: "adapter 'codelldb' is not available: install the CodeLLDB extension (https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) and ensure the codelldb binary is on PATH, or configure the path in the 'adapters' plugin config.",
        // codelldb listens on a random high port when started with --port 0;
        // the actual port is written to stdout as "Listening on port <N>\n".
        transport: 'tcp',
    },
];
/** Failed adapter resolution with the actionable message to surface. */
export class AdapterUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AdapterUnavailableError';
    }
}
/** Resolved launch request for {@link spawnDapAdapter}. */
export function resolveAdapter(options, adapterConfig, commandExists = defaultCommandExists) {
    const recipes = mergeRecipes(adapterConfig);
    const wanted = options.adapter ?? guessAdapterId(options.program);
    if (wanted === undefined) {
        const available = recipes.filter(recipe => recipe.probeCommands.some(commandExists)).map(recipe => recipe.id);
        throw new AdapterUnavailableError(`No debugger adapter matches '${options.program}'. Pass 'adapter' explicitly (available: ${available.length > 0 ? available.join(', ') : 'none'}). Custom adapters are declared in the 'adapters' plugin config.`);
    }
    const recipe = recipes.find(entry => entry.id === wanted);
    if (recipe === undefined) {
        if (wanted === 'js-debug') {
            // js-debug ships as a TCP DAP server script (dapDebugServer.js), not as
            // a PATH binary, and is never published to npm (it is bundled with VS
            // Code under extensions/ms-vscode.js-debug). No auto-resolvable
            // built-in recipe exists, so fail fast with the exact config shape
            // instead of spawning a bare `node` REPL that would hang until the
            // request timeout.
            throw new AdapterUnavailableError("adapter 'js-debug' has no built-in command: it is a VS Code-bundled TCP DAP server script, not an npm-installable binary. Declare it in the plugin's 'adapters' config, e.g. adapters: { 'js-debug': { command: 'node', args: ['<VS Code>/extensions/ms-vscode.js-debug/dist/src/dapDebugServer.js'], transport: 'tcp', connectPort: 12722 } }.");
        }
        throw new AdapterUnavailableError(`Unknown adapter '${wanted}'. Declare it under the plugin's 'adapters' config or use a built-in id (${recipes
            .map(entry => entry.id)
            .join(', ')}).`);
    }
    if (recipe.configOverride !== undefined) {
        const spec = expandConfigEntry(recipe.configOverride);
        spec.launchArgs = recipe.configOverride.launchArgs ?? recipe.launchArgs;
        spec.stopOnEntryKey = recipe.stopOnEntryKey ?? 'stopOnEntry';
        spec.exceptionFilterMap = recipe.configOverride.exceptionFilterMap ?? recipe.exceptionFilterMap;
        return spec;
    }
    const command = recipe.probeCommands.find(commandExists);
    if (command === undefined)
        throw new AdapterUnavailableError(recipe.installHint);
    return {
        command,
        args: recipe.fixedArgs,
        launchArgs: recipe.launchArgs,
        stopOnEntryKey: recipe.stopOnEntryKey ?? 'stopOnEntry',
        exceptionFilterMap: recipe.exceptionFilterMap,
        transport: recipe.transport,
    };
}
function mergeRecipes(adapterConfig) {
    const recipes = BUILT_IN_RECIPES.map(recipe => ({ ...recipe }));
    for (const [id, entry] of Object.entries(adapterConfig ?? {})) {
        const existing = recipes.find(recipe => recipe.id === id);
        if (existing === undefined) {
            recipes.push({
                id,
                probeCommands: [entry.command],
                fixedArgs: [],
                installHint: `adapter '${id}' is not available: configured command '${entry.command}' did not resolve on PATH`,
                configOverride: entry,
            });
        }
        else {
            existing.configOverride = entry;
        }
    }
    return recipes;
}
function expandConfigEntry(entry) {
    return {
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env,
        cwd: entry.cwd,
        launchArgs: entry.launchArgs,
        exceptionFilterMap: entry.exceptionFilterMap,
        transport: entry.transport,
        host: entry.connectHost,
        port: entry.connectPort,
        portPattern: entry.portPattern,
        announceStream: entry.announceStream,
    };
}
function guessAdapterId(program) {
    const lower = program.toLowerCase();
    if (lower.endsWith('.py'))
        return 'debugpy';
    if (lower.endsWith('.go'))
        return 'dlv';
    if (lower.endsWith('.dll') || lower.endsWith('.exe'))
        return 'netcoredbg';
    if (lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.cxx') || lower.endsWith('.h') || lower.endsWith('.hpp'))
        return 'lldb-dap';
    if (lower.endsWith('.rs'))
        return 'codelldb';
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts'))
        return 'js-debug';
    return undefined;
}
/**
 * Default PATH probe. Absolute paths are checked directly; bare names are
 * probed against every PATH directory with the platform executable suffixes.
 */
export function defaultCommandExists(command) {
    if (isAbsolute(command)) {
        try {
            accessSync(command);
            return true;
        }
        catch {
            return false;
        }
    }
    const directories = (process.env.PATH ?? '').split(delimiter).filter(entry => entry.length > 0);
    const extensions = process.platform === 'win32'
        ? Array.from(new Set([(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map(ext => ext.toLowerCase()), ''].flat()))
        : [''];
    for (const directory of directories) {
        for (const extension of extensions) {
            try {
                accessSync(join(directory, command + extension));
                return true;
            }
            catch {
                // try the next candidate
            }
        }
    }
    return false;
}
//# sourceMappingURL=adapters.js.map