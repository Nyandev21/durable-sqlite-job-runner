import { createHash } from "node:crypto";
import { z } from "zod";
import type { JobHandler } from "./types.js";

const uppercasePayload = z.object({ text: z.string() });
const checksumPayload = z.object({ value: z.string() });

export const handlers: Readonly<Record<string, JobHandler>> = {
  uppercase(payload) {
    const parsed = uppercasePayload.parse(payload);
    return { text: parsed.text.toUpperCase() };
  },
  checksum(payload) {
    const parsed = checksumPayload.parse(payload);
    return { sha256: createHash("sha256").update(parsed.value).digest("hex") };
  },
};
