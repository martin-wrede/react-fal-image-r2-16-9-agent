// functions/api/agent.js
// Cloudflare Pages Function — Moon News agent orchestration endpoint
//
// Called by Hermes (Hostinger VPS) to submit a full episode for processing.
// Hermes then calls /ai for each story individually to generate images + videos.
//
// Required bindings (same as functions/ai.js):
//   IMAGE_BUCKET   — R2 bucket binding
//   TASK_INFO_KV   — KV namespace binding
//   R2_PUBLIC_URL  — env var: public R2 base URL
//
// Routes:
//   POST /api/agent                        — submit episode, get back story task list
//   POST /api/agent  { action: 'status' }  — check episode processing status
//   GET  /api/agent?episodeDate=YYYY-MM-DD — fetch stored episode JSON

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  // ── GET /api/agent?episodeDate=YYYY-MM-DD — fetch episode ─────────────────
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const episodeDate = url.searchParams.get('episodeDate');
    if (!episodeDate) {
      return jsonError('Missing episodeDate query parameter', 400);
    }
    try {
      const obj = await env.IMAGE_BUCKET.get(`projects/${episodeDate}/project.json`);
      if (!obj) return jsonError(`No episode found for ${episodeDate}`, 404);
      const data = await obj.json();
      return jsonOk(data);
    } catch (err) {
      return jsonError(err.message, 500);
    }
  }

  if (request.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { action } = body;

  // ── POST /api/agent { action: 'status' } — check episode status ───────────
  if (action === 'status') {
    const { episodeDate } = body;
    if (!episodeDate) return jsonError('Missing episodeDate', 400);
    try {
      const obj = await env.IMAGE_BUCKET.get(`projects/${episodeDate}/project.json`);
      if (!obj) return jsonError(`No episode found for ${episodeDate}`, 404);
      const episode = await obj.json();
      const total = episode.stories.length;
      const withImage = episode.stories.filter(s => s.generatedImageUrl).length;
      const withVideo = episode.stories.filter(s => s.videoUrl).length;
      return jsonOk({
        episodeDate,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        status: episode.status,
        progress: { total, withImage, withVideo },
        stories: episode.stories.map(s => ({
          index: s.index,
          headline: s.headline,
          generatedImageUrl: s.generatedImageUrl || null,
          videoUrl: s.videoUrl || null,
        })),
      });
    } catch (err) {
      return jsonError(err.message, 500);
    }
  }

  // ── POST /api/agent — update a story with generated URLs ──────────────────
  if (action === 'updateStory') {
    const { episodeDate, storyIndex, generatedImageUrl, videoUrl } = body;
    if (!episodeDate || storyIndex === undefined) {
      return jsonError('Missing episodeDate or storyIndex', 400);
    }
    try {
      const r2Key = `projects/${episodeDate}/project.json`;
      const obj = await env.IMAGE_BUCKET.get(r2Key);
      if (!obj) return jsonError(`No episode found for ${episodeDate}`, 404);
      const episode = await obj.json();

      const story = episode.stories.find(s => s.index === storyIndex);
      if (!story) return jsonError(`Story index ${storyIndex} not found`, 404);

      if (generatedImageUrl) story.generatedImageUrl = generatedImageUrl;
      if (videoUrl) story.videoUrl = videoUrl;

      // Update overall episode status
      const allDone = episode.stories.every(s => s.videoUrl);
      episode.status = allDone ? 'complete' : 'processing';
      episode.updatedAt = new Date().toISOString();

      await env.IMAGE_BUCKET.put(r2Key, JSON.stringify(episode, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      });

      return jsonOk({
        success: true,
        storyIndex,
        episodeStatus: episode.status,
        updatedAt: episode.updatedAt,
      });
    } catch (err) {
      return jsonError(err.message, 500);
    }
  }

  // ── POST /api/agent — submit new episode ──────────────────────────────────
  // Body: full Moon News project JSON (from moon-news SKILL.md)
  if (!body.episodeDate || !Array.isArray(body.stories) || body.stories.length === 0) {
    return jsonError('Body must include episodeDate and non-empty stories array', 400);
  }

  const episodeDate = body.episodeDate;
  const episodeNumber = body.episodeNumber || 0;
  const r2Key = `projects/${episodeDate}/project.json`;

  // Enrich episode with processing metadata
  const episode = {
    ...body,
    projectId: `moon-news-${episodeDate}-${Date.now()}`,
    status: 'queued',
    receivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agentEndpoint: `${new URL(request.url).origin}/api/agent`,
    aiEndpoint: `${new URL(request.url).origin}/ai`,
  };

  try {
    await env.IMAGE_BUCKET.put(r2Key, JSON.stringify(episode, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (err) {
    return jsonError(`Failed to store episode in R2: ${err.message}`, 500);
  }

  // Return per-story task list so Hermes knows exactly what to call next
  const storyTasks = episode.stories.map(s => ({
    index: s.index,
    headline: s.headline,
    imagePrompt: s.imagePrompt,
    videoPrompt: s.videoPrompt,
    sceneType: s.sceneType,
  }));

  console.log(`[moon-news] Episode ${episodeDate} (#${episodeNumber}) stored — ${episode.stories.length} stories queued`);

  return jsonOk({
    projectId: episode.projectId,
    episodeDate,
    episodeNumber,
    status: 'queued',
    storyCount: episode.stories.length,
    r2Key,
    r2Url: env.R2_PUBLIC_URL ? `${env.R2_PUBLIC_URL}/${r2Key}` : null,
    // Hermes uses these endpoints to drive generation per story:
    aiEndpoint: episode.aiEndpoint,
    agentEndpoint: episode.agentEndpoint,
    // What Hermes needs to call for each story:
    storyTasks,
    instructions: {
      step1: "For each storyTask: POST aiEndpoint with { action: 'generateImage', prompt: imagePrompt, ratio: '1280:720' }",
      step2: "Poll aiEndpoint with { action: 'status', taskId } every 4s until status === 'SUCCEEDED' — get imageUrl",
      step3: "POST aiEndpoint with { action: 'startVideoFromUrl', videoPrompt, imageUrl, duration: 5, ratio: '1280:720' }",
      step4: "Poll aiEndpoint with { action: 'status', taskId } every 4s until status === 'SUCCEEDED' — get videoUrl",
      step5: "POST agentEndpoint with { action: 'updateStory', episodeDate, storyIndex, generatedImageUrl, videoUrl }",
    },
  });
}

function jsonOk(data) {
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
