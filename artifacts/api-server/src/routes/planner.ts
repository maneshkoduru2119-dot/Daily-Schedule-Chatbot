import { Router, type IRouter } from "express";
import { GoogleGenAI } from "@google/genai";
import {
  PlanDayChatBody,
  PlanDayChatResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const REQUEST_LIMIT = 12;
const WINDOW_MS = 60_000;

function isValidPlan(
  plan: NonNullable<ReturnType<typeof PlanDayChatResponse.parse>["plan"]>,
  dayStart: string,
  dayEnd: string,
): boolean {
  const sorted = [...plan.tasks].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
  let previousEnd = dayStart;

  for (const task of sorted) {
    if (
      task.startTime < dayStart ||
      task.endTime > dayEnd ||
      task.startTime >= task.endTime ||
      task.startTime < previousEnd
    ) {
      return false;
    }
    previousEnd = task.endTime;
  }

  return sorted.length > 0;
}

router.post("/planner/chat", async (req, res): Promise<void> => {
  const parsed = PlanDayChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please check the schedule details and try again." });
    return;
  }

  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (entry.resetAt <= now) requestCounts.delete(ip);
  }

  const clientKey = req.ip || req.socket.remoteAddress || "unknown";
  const current = requestCounts.get(clientKey);
  if (current && current.resetAt > now && current.count >= REQUEST_LIMIT) {
    res.status(429).json({ error: "Too many planning requests. Please wait a minute and try again." });
    return;
  }
  requestCounts.set(
    clientKey,
    current && current.resetAt > now
      ? { count: current.count + 1, resetAt: current.resetAt }
      : { count: 1, resetAt: now + WINDOW_MS },
  );

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "The schedule assistant is not configured yet." });
    return;
  }

  const input = parsed.data;
  const context = [
    `Date to plan: ${input.date}`,
    `User time zone: ${input.timeZone}`,
    `Available day: ${input.dayStart} to ${input.dayEnd}`,
    `Current schedule: ${JSON.stringify(input.existingTasks)}`,
  ].join("\n");

  try {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: input.messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
      config: {
        systemInstruction: `You are a practical, supportive personal schedule planner. Help the user make a realistic timed plan for the selected day. Do not claim you changed or saved their schedule: only return a proposal for the user to apply. Never mark tasks complete; completion is tracked separately by the user.

${context}

Return exactly one JSON object with this shape: {"message":"a concise helpful response","plan":null} or {"message":"a concise introduction to the schedule","plan":{"date":"${input.date}","summary":"brief summary","tasks":[{"title":"task name","startTime":"HH:MM","endTime":"HH:MM","category":"optional short label"}]}}.

When the user asks you to make or revise a schedule, include a plan with at least one task. Ask a short clarifying question and use plan:null if there is not enough information to make a useful schedule. Use 24-hour local times, keep every task within the available day, and never overlap tasks. Leave reasonable breaks and include existing tasks when revising. Treat completed tasks as fixed commitments. Do not add unsupported assumptions about the user's calendar.`,
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    });

    const text = result.text;
    if (!text) {
      res.status(502).json({ error: "The schedule assistant returned an empty response. Please try again." });
      return;
    }

    const response = PlanDayChatResponse.parse(JSON.parse(text));
    if (response.plan) {
      response.plan.date = input.date;
      if (!isValidPlan(response.plan, input.dayStart, input.dayEnd)) {
        res.status(502).json({ error: "I couldn't fit those tasks into the available hours without a conflict. Please adjust the tasks or time window and try again." });
        return;
      }
    }

    res.json(response);
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Schedule assistant request failed",
    );
    res.status(502).json({ error: "The schedule assistant couldn't create a reply. Please try again." });
  }
});

export default router;
