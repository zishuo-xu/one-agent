import { ToolCall, ToolDefinition, ToolResult } from './types.js';
import { ToolRegistry } from './registry.js';

export class ToolExecutor {
  constructor(private registry: ToolRegistry) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    let tool: ToolDefinition;
    try {
      tool = this.registry.get(call.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }

    const parseResult = tool.parameters.safeParse(call.arguments);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid parameters for tool "${call.name}": ${parseResult.error.message}`,
      };
    }

    try {
      const data = await tool.execute(parseResult.data);
      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Tool "${call.name}" execution failed: ${message}`,
      };
    }
  }
}
