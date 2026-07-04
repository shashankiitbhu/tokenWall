export class VerbositySteering {
  static getSteeringInstructions(config: any, contextReport: any): string[] {
    const instructions: string[] = [];
    if (config?.verbositySteering !== false) {
      instructions.push("Be highly concise. Avoid explaining context, preambles, or restating unchanged files. Output only the requested edits or response directly.");
    }
    if (contextReport?.deduplicationsApplied && contextReport.deduplicationsApplied > 0) {
      instructions.push("TokenWall Optimization: To save context space, redundant file contents may be replaced with `[TokenWall: File identical to earlier occurrence. Refer to the chat history above for <path>]`. If you see this marker, DO NOT ask the user to provide the file. You already have the full file contents earlier in this conversation history. Scroll up to read it.");
    }
    if (contextReport?.cachedContents && contextReport.cachedContents.length > 0) {
      instructions.push("TokenWall Reversible Masking: To save context space, some large function bodies or arrays have been masked with `[TokenWall Reversible Content: <id>]`. If you need to edit or precisely reason about a masked region, you MUST call the `tokenwall_retrieve_content` tool first. If uncertain, retrieve rather than guess.");
    }
    return instructions;
  }
}
