import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { type Props, WhoopApiError, WhoopClient } from "./whoop";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const rangeSchema = {
	start: z
		.string()
		.optional()
		.describe("ISO 8601 start time, inclusive (e.g. 2026-11-01T00:00:00Z). Defaults to the most recent records."),
	end: z.string().optional().describe("ISO 8601 end time, exclusive. Defaults to now."),
	limit: z.number().int().min(1).max(200).default(10).describe("Max records to return (newest first)."),
};

function client() {
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props?.accessToken) throw new Error("Not signed in to WHOOP.");
	return new WhoopClient(props.accessToken);
}

function json(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Wraps a tool body so WHOOP API errors come back as readable tool errors. */
function run(fn: () => Promise<unknown>) {
	return fn().then(json, (err: unknown) => ({
		isError: true,
		content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
	}));
}

export function createServer() {
	const server = new McpServer({ name: "WHOOP", version: "1.0.0" });

	server.registerTool(
		"get_profile",
		{
			title: "WHOOP profile",
			description: "The signed-in WHOOP member's name, email, height, weight and max heart rate.",
			annotations: READ_ONLY,
		},
		() =>
			run(async () => {
				const c = client();
				const [profile, body] = await Promise.all([c.profile(), c.get("/v2/user/measurement/body")]);
				return { profile, body_measurement: body };
			}),
	);

	server.registerTool(
		"get_today",
		{
			title: "Today's WHOOP summary",
			description:
				"The current physiological cycle (day strain, kJ, heart rate) with its recovery (score, HRV, resting HR, SpO2, skin temp) and the sleep that preceded it.",
			annotations: READ_ONLY,
		},
		() =>
			run(async () => {
				const c = client();
				const [cycle] = await c.collection<{ id: number }>("/v2/cycle", { max: 1 });
				if (!cycle) return { message: "No cycles found." };
				const [recovery, sleep] = await Promise.all([
					c.get(`/v2/cycle/${cycle.id}/recovery`),
					c.get(`/v2/cycle/${cycle.id}/sleep`),
				]);
				return { cycle, recovery, sleep };
			}),
	);

	server.registerTool(
		"get_recoveries",
		{
			title: "WHOOP recoveries",
			description:
				"Recovery scores over a time range: recovery %, HRV (rmssd ms), resting heart rate, SpO2 and skin temperature.",
			inputSchema: rangeSchema,
			annotations: READ_ONLY,
		},
		({ start, end, limit }) => run(() => client().collection("/v2/recovery", { start, end, max: limit })),
	);

	server.registerTool(
		"get_sleeps",
		{
			title: "WHOOP sleeps",
			description:
				"Sleep activities over a time range: stage durations (light, SWS, REM, awake), sleep performance, efficiency, consistency, respiratory rate, and naps.",
			inputSchema: rangeSchema,
			annotations: READ_ONLY,
		},
		({ start, end, limit }) => run(() => client().collection("/v2/activity/sleep", { start, end, max: limit })),
	);

	server.registerTool(
		"get_workouts",
		{
			title: "WHOOP workouts",
			description:
				"Workouts over a time range: sport, strain, average/max heart rate, kilojoules, distance, altitude and heart-rate zone durations.",
			inputSchema: rangeSchema,
			annotations: READ_ONLY,
		},
		({ start, end, limit }) => run(() => client().collection("/v2/activity/workout", { start, end, max: limit })),
	);

	server.registerTool(
		"get_cycles",
		{
			title: "WHOOP cycles",
			description:
				"Physiological cycles (roughly one per day, wake to wake) over a time range: day strain, kilojoules, average and max heart rate.",
			inputSchema: rangeSchema,
			annotations: READ_ONLY,
		},
		({ start, end, limit }) => run(() => client().collection("/v2/cycle", { start, end, max: limit })),
	);

	server.registerTool(
		"get_sleep_by_id",
		{
			title: "WHOOP sleep by ID",
			description: "One sleep activity by its UUID.",
			inputSchema: { sleep_id: z.string().uuid() },
			annotations: READ_ONLY,
		},
		({ sleep_id }) => run(() => client().get(`/v2/activity/sleep/${sleep_id}`)),
	);

	server.registerTool(
		"get_workout_by_id",
		{
			title: "WHOOP workout by ID",
			description: "One workout by its UUID.",
			inputSchema: { workout_id: z.string().uuid() },
			annotations: READ_ONLY,
		},
		({ workout_id }) => run(() => client().get(`/v2/activity/workout/${workout_id}`)),
	);

	return server;
}

export { WhoopApiError };
