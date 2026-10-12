import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { SendAssistantChatBody } from "@workspace/api-zod";

const router: IRouter = Router();

let openaiClient: OpenAI | undefined;

function getOpenAIClient(): OpenAI | undefined {
  const apiKey = process.env["Full_stack_Application"];
  if (!apiKey) {
    return undefined;
  }

  openaiClient ??= new OpenAI({ apiKey });
  return openaiClient;
}

router.post("/assistant/chat", async (req, res): Promise<void> => {
  const parsed = SendAssistantChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please check your message and try again." });
    return;
  }

  const messages = parsed.data.messages;
  if (messages[messages.length - 1]?.role !== "user") {
    res.status(400).json({ error: "Your latest message must be a question." });
    return;
  }

  const client = getOpenAIClient();
  if (!client) {
    res.status(503).json({
      error: "The assistant API key is not configured for this app.",
    });
    return;
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const stream = await client.chat.completions.create(
      {
        model: "gpt-5-mini",
        max_completion_tokens: 8192,
        messages,
        stream: true,
      },
      { signal: controller.signal },
    );

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    for await (const chunk of stream) {
      if (controller.signal.aborted) {
        return;
      }

      const content = chunk.choices[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    if (!controller.signal.aborted && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }

    const upstreamStatus =
      error instanceof OpenAI.APIError ? error.status : undefined;
    req.log.error(
      { upstreamStatus },
      "Assistant response generation failed",
    );
    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: "The assistant could not finish this reply. Please try again." })}\n\n`,
      );
      res.end();
      return;
    }

    const errorMessage =
      upstreamStatus === 401 || upstreamStatus === 403
        ? "The saved API key was rejected. Check that it is an OpenAI key with chat access."
        : upstreamStatus === 404
          ? "This API key cannot access the selected chat model."
          : "The assistant could not respond. Check the saved API key and try again.";
    res.status(502).json({
      error: errorMessage,
    });
  }
});

export default router;
