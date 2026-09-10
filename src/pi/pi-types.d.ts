export interface ExtensionUI { notify(message: string, level?: "info" | "warning" | "error"): void; }
export interface ExtensionCommandContext { cwd: string; signal?: AbortSignal; sessionManager?: { getSessionFile(): string | undefined }; ui: ExtensionUI; }
export interface ExtensionAPI { registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void; }
