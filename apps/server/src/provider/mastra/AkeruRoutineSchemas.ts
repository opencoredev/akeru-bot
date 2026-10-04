import { z } from "zod";

export const routineTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const AKERU_LIST_ROUTINES_TOOL_NAME = "akeru_list_routines";

export const AKERU_DELETE_ROUTINES_TOOL_NAME = "akeru_delete_routines";

export const routineToolInputSchema = z.object({
  name: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("daily"), time: routineTime }),
    z.object({ kind: z.literal("weekdays"), time: routineTime }),
    z.object({
      kind: z.literal("weekly"),
      weekdays: z
        .array(
          z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
        )
        .min(1),
      time: routineTime,
    }),
  ]),
  skillNames: z.array(z.string().trim().min(1)).nullish(),
  connectorNames: z.array(z.string().trim().min(1)).nullish(),
});

export const routineListOutputSchema = z.object({
  routines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      lifecycle: z.enum([
        "draft",
        "approved",
        "enabled",
        "running",
        "paused",
        "blocked",
        "failed",
        "completed",
      ]),
    }),
  ),
});

export type AkeruRoutineListResult = z.infer<typeof routineListOutputSchema>;

export const routineDeleteResultSchema = z.object({
  status: z.enum(["deleted", "cancelled", "not-found"]),
  deletedRoutineIds: z.array(z.string()),
});

export type AkeruRoutineDeleteResult = z.infer<typeof routineDeleteResultSchema>;
