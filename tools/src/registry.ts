import { z } from "zod";
import { MorrowError } from "@morrow/shared";
import { ToolDescriptorSchema, type ToolDescriptor } from "@morrow/schemas";
import { capabilitiesOf, type AnyTool } from "./contract";

/** The set of tools the runtime knows about. Registration is explicit — no discovery by name. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.id)) throw new MorrowError("TOOL_ALREADY_REGISTERED", `Tool ${tool.id} is already registered`);
    if (tool.permissions.length === 0 && tool.riskLevel !== "SAFE") {
      throw new MorrowError("TOOL_UNDECLARED_PERMISSIONS", `Tool ${tool.id} must declare its permissions`);
    }
    this.tools.set(tool.id, tool);
  }

  get(id: string): AnyTool | null {
    return this.tools.get(id) ?? null;
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  async describe(): Promise<ToolDescriptor[]> {
    return Promise.all(
      this.list().map(async (tool) =>
        ToolDescriptorSchema.parse({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          version: tool.version,
          category: tool.category,
          riskLevel: tool.riskLevel,
          capabilities: capabilitiesOf(tool),
          permissions: tool.permissions.map((p) => ({ ...p, toolId: tool.id })),
          inputJsonSchema: z.toJSONSchema(tool.inputSchema),
          outputJsonSchema: z.toJSONSchema(tool.outputSchema),
          availability: await tool.availability(),
        }),
      ),
    );
  }
}
