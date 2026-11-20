import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export default function referenceFixture(pi) {
  if (process.env.PANDA_FIXTURE_CHANGE_REPLAY === "1") {
    pi.on("context", event => ({ messages: event.messages.map(message => message.role === "user" ? {
      ...message, content: typeof message.content === "string" ? message.content + " Transformed fixture." :
        [...message.content, { type: "text", text: "Transformed fixture." }],
    } : message) }));
  }
  pi.registerTool({
    name: "panda_fixture_read",
    label: "Read fixture",
    description: "Read the single integration fixture.",
    parameters: {
      ...(process.env.PANDA_FIXTURE_DIALECT ? { $schema: process.env.PANDA_FIXTURE_DIALECT } : {}),
      type: "object", $defs: { "file/path": { $ref: "#/definitions/path" } },
      definitions: { path: { type: "string" } },
      properties: { path: { $ref: "#/$defs/file~1path", description: "Local fixture path" } },
      required: ["path"],
    },
    async execute(_id, { path }) {
      if (resolve(path) !== resolve("capture-fixture.txt")) throw new Error("Unknown fixture.");
      return { content: [{ type: "text", text: (await readFile(path, "utf8")).trim() }], details: {} };
    },
  });
}
