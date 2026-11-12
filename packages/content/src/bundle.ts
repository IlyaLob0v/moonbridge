import { createHash } from "node:crypto";
import type { ContentBundle, Task } from "./types.js";
import type { ValidatedContent } from "./validate.js";

/**
 * Flattens validated content into the bundle the platform and Moonbridge load. The hash covers the
 * content only (not the build time), so an unchanged content tree gives the same hash.
 */
export function buildBundle(content: ValidatedContent, builtAt = new Date()): ContentBundle {
  const tasks: Record<string, Task & { module_id: string }> = {};
  for (const set of content.taskSets) {
    for (const task of set.tasks) tasks[task.task_id] = { ...task, module_id: set.module_id };
  }
  const body = {
    taxonomy: content.taxonomy,
    modules: [...content.modules].sort((a, b) => a.module_id.localeCompare(b.module_id)),
    tasks: Object.fromEntries(Object.entries(tasks).sort(([a], [b]) => a.localeCompare(b))),
    courses: [...content.courses].sort((a, b) => a.course_id.localeCompare(b.course_id)),
    ...(content.moonbridge
      ? {
          moonbridge: {
            places: [...content.moonbridge.places].sort((a, b) => a.place_id.localeCompare(b.place_id)),
            characters: [...content.moonbridge.characters].sort((a, b) => a.character_id.localeCompare(b.character_id)),
            episodes: [...content.moonbridge.episodes].sort((a, b) => a.episode_id.localeCompare(b.episode_id)),
            ...(content.moonbridge.daily
              ? {
                  daily: {
                    guests: [...content.moonbridge.daily.guests].sort((a, b) => a.guest_id.localeCompare(b.guest_id)),
                    lost_items: [...content.moonbridge.daily.lost_items].sort((a, b) => a.item_id.localeCompare(b.item_id)),
                  },
                }
              : {}),
            ...(content.moonbridge.welcome ? { welcome: content.moonbridge.welcome } : {}),
          },
        }
      : {}),
  };
  const content_hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { bundle_schema_version: "2.0", content_hash, built_at: builtAt.toISOString(), ...body };
}
