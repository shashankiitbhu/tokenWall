export class ToolTrimmer {
  static trim(tools: any[]) {
    if (!tools || !Array.isArray(tools)) return tools;
    
    for (const tool of tools) {
      if (typeof tool === 'object' && tool !== null) {
        // OpenAI / Anthropic format
        if (tool.function && typeof tool.function.name === 'string') {
          this.applyTrims(tool.function);
        } else if (typeof tool.name === 'string') {
          this.applyTrims(tool);
        }
        
        // Gemini format
        if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
          for (const funcDecl of tool.functionDeclarations) {
            this.applyTrims(funcDecl);
          }
        }
      }
    }
    return tools;
  }

  private static applyTrims(funcObj: any) {
    if (!funcObj || typeof funcObj.name !== 'string') return;
    
    if (funcObj.name === 'execute_command') {
      funcObj.description = 'Execute a CLI command. Chain with &&. Use absolute paths.';
      if (funcObj.parameters?.properties) {
        if (funcObj.parameters.properties.command) {
          funcObj.parameters.properties.command.description = 'CLI command to execute. Chain with &&.';
        }
        if (funcObj.parameters.properties.requires_approval) {
          funcObj.parameters.properties.requires_approval.description = 'True if destructive, false otherwise.';
        }
      }
    } else if (funcObj.name === 'read_file') {
      funcObj.description = 'Read file contents. Uses start_line and end_line. Only for files.';
      // We intentionally do NOT trim the path property to preserve exact workspace rules.
    } else if (funcObj.name === 'list_files' || funcObj.name === 'list_dir') {
      funcObj.description = 'List directory contents.';
    } else if (funcObj.name === 'browser_action') {
      funcObj.description = 'Perform browser automation.';
    } else if (funcObj.name === 'replace_file_content' || funcObj.name === 'multi_replace_file_content' || funcObj.name === 'edit_file') {
      funcObj.description = 'Edit existing files by specifying target strings and replacements.';
    }
  }
}
