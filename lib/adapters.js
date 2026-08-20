/**
 * Adapter recipes: built-in stdio DAP adapters (debugpy, dlv) plus
 * config-declared rows, resolved against PATH with actionable install hints.
 */
import { delimiter, isAbsolute, join } from 'node:path';
import { accessSync } from 'node:fs';
const BUILT_IN_RECIPES = [
    {
        id: 'debugpy',
        probeCommands: ['python', 'python3'],
        fixedArgs: ['-m', 'debugpy.adapter'],
        installHint: "adapter 'debugpy' is not available: install the debugpy module ('pip install debugpy') and ensure 'python' is on PATH",
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
        throw new AdapterUnavailableError(`No debugger adapter matches '${options.program}'. Pass 'adapter' explicitly (available: ${available.length > 0 ? available.join(', ') : 'none'}). Custom stdio adapters are declared in the 'adapters' config.`);
    }
    const recipe = recipes.find(entry => entry.id === wanted);
    if (recipe === undefined) {
        throw new AdapterUnavailableError(`Unknown adapter '${wanted}'. Declare it under the plugin's 'adapters' config or use a built-in id (${recipes
            .map(entry => entry.id)
            .join(', ')}).`);
    }
    if (recipe.configOverride !== undefined) {
        const spec = expandConfigEntry(recipe.configOverride);
        // Inherit the built-in's launch defaults unless the override provides its own;
        // the stop-on-entry field name remains a recipe property (override changes path/args only).
        spec.launchArgs = recipe.configOverride.launchArgs ?? recipe.launchArgs;
        spec.stopOnEntryKey = recipe.stopOnEntryKey ?? 'stopOnEntry';
        return spec;
    }
    const command = recipe.probeCommands.find(commandExists);
    if (command === undefined)
        throw new AdapterUnavailableError(recipe.installHint);
    return { command, args: recipe.fixedArgs, launchArgs: recipe.launchArgs, stopOnEntryKey: recipe.stopOnEntryKey ?? 'stopOnEntry' };
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
    return { command: entry.command, args: entry.args ?? [], env: entry.env, cwd: entry.cwd, launchArgs: entry.launchArgs };
}
function guessAdapterId(program) {
    if (program.endsWith('.py'))
        return 'debugpy';
    if (program.endsWith('.go'))
        return 'dlv';
    // A compiled .NET assembly (dll) or an apphost exe launches under netcoredbg.
    if (program.endsWith('.dll') || program.endsWith('.exe'))
        return 'netcoredbg';
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
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
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