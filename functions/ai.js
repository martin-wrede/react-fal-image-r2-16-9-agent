const FAL_API_BASE = 'https://queue.fal.run';
const FAL_MODEL = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';

function resolveRuntimeConfig(env) {
  const apiKey = env.FAL_KEY || env.FAL_API_KEY || env.RUNWAYML_API_KEY || (typeof process !== 'undefined' ? process.env?.FAL_API_KEY : undefined);

  return {
    apiKey,
    r2PublicUrl: env.R2_PUBLIC_URL,
    imageBucket: env.IMAGE_BUCKET,
    taskInfoKv: env.TASK_INFO_KV,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const runtimeConfig = resolveRuntimeConfig(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }});
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!runtimeConfig.apiKey || !runtimeConfig.r2PublicUrl || !runtimeConfig.imageBucket || !runtimeConfig.taskInfoKv) {
    const missing = [];
    if (!runtimeConfig.apiKey) missing.push('FAL_KEY/FAL_API_KEY');
    if (!runtimeConfig.r2PublicUrl) missing.push('R2_PUBLIC_URL');
    if (!runtimeConfig.imageBucket) missing.push('IMAGE_BUCKET');
    if (!runtimeConfig.taskInfoKv) missing.push('TASK_INFO_KV');

    const errorMsg = `CRITICAL: Check Cloudflare settings for ${missing.join(', ')}.`;
    console.error(errorMsg);
    return new Response(JSON.stringify({ success: false, error: errorMsg }), { status: 500 });
  }

  const FAL_HEADERS = {
    'Authorization': `Key ${runtimeConfig.apiKey}`,
    'Content-Type': 'application/json'
  };

  try {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const prompt = formData.get('prompt');
      const imageFile = formData.get('image');
      const duration = formData.get('duration') || '5';
      const aspectRatio = formData.get('ratio') || '16:9';

      if (!prompt || !imageFile) throw new Error('Missing prompt or image file.');

      const imageKey = `uploads/${Date.now()}-${imageFile.name}`;
      await runtimeConfig.imageBucket.put(imageKey, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
      const imageUrl = `${runtimeConfig.r2PublicUrl}/${imageKey}`;

      return await startImageToVideoJob(imageUrl, prompt, duration, aspectRatio, imageFile.name, runtimeConfig, FAL_HEADERS);
    }

    else if (contentType.includes('application/json')) {
      const body = await request.json();
      const { action } = body;

      switch (action) {
        case 'status': {
          const { taskId } = body;
          if (!taskId) throw new Error('Invalid status check request.');

          const statusUrl = `${FAL_API_BASE}/${FAL_MODEL}/requests/${taskId}/status`;
          const statusRes = await fetch(statusUrl, { headers: { 'Authorization': `Key ${runtimeConfig.apiKey}` } });
          const statusText = await statusRes.text();
          let statusData = {};
          try {
            statusData = statusText ? JSON.parse(statusText) : {};
          } catch {
            throw new Error(`Fal.ai returned invalid status JSON for task ${taskId}`);
          }

          if (!statusRes.ok) throw new Error(`Status check failed: ${statusData.detail || statusRes.statusText}`);

          if (statusData.status === 'ERROR' || statusData.status === 'FAILED') {
            throw new Error(`Fal.ai video generation failed: ${statusData.error || statusData.status}`);
          }

          if (statusData.status === 'COMPLETED') {
            const taskInfo = await runtimeConfig.taskInfoKv.get(taskId, { type: 'json' });
            if (!taskInfo?.r2Key) throw new Error(`Could not find R2 destination key for task ${taskId}.`);

            const resultRes = await fetch(`${FAL_API_BASE}/${FAL_MODEL}/requests/${taskId}`, {
              headers: { 'Authorization': `Key ${runtimeConfig.apiKey}` }
            });
            const resultText = await resultRes.text();
            let resultData = {};
            try {
              resultData = resultText ? JSON.parse(resultText) : {};
            } catch {
              throw new Error(`Fal.ai returned invalid result JSON for task ${taskId}`);
            }
            if (!resultRes.ok) throw new Error(`Failed to retrieve result: ${resultData.detail || resultRes.statusText}`);

            const falVideoUrl = resultData.video?.url;
            if (!falVideoUrl) throw new Error('No video URL returned by Fal.ai.');

            console.log(`[${taskId}] Downloading video from Fal.ai: ${falVideoUrl}`);
            const videoRes = await fetch(falVideoUrl);
            if (!videoRes.ok) throw new Error(`Failed to download video from Fal.ai: ${videoRes.status}`);

            await runtimeConfig.imageBucket.put(taskInfo.r2Key, videoRes.body, { httpMetadata: { contentType: 'video/mp4' } });
            console.log(`[${taskId}] Saved to R2: ${taskInfo.r2Key}`);

            const finalUrl = `${taskInfo.r2PublicUrl}/${taskInfo.r2Key}`;
            context.waitUntil(runtimeConfig.taskInfoKv.delete(taskId));

            return jsonResponse({ success: true, status: 'SUCCEEDED', progress: 1, videoUrl: finalUrl });
          }

          const progress = statusData.status === 'IN_PROGRESS' ? 0.5 : 0;
          return jsonResponse({ success: true, status: statusData.status, progress });
        }

        default:
          throw new Error('Invalid action specified.');
      }
    }
    else {
      throw new Error('Invalid request content-type.');
    }
  } catch (error) {
    console.error('Error:', error.message);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

async function startImageToVideoJob(imageUrl, prompt, duration, aspectRatio, originalName, runtimeConfig, falHeaders) {
  const baseName = originalName.split('.').slice(0, -1).join('.') || originalName;
  const videoKey = `videos/${Date.now()}-${baseName}.mp4`;

  const response = await fetch(`${FAL_API_BASE}/${FAL_MODEL}`, {
    method: 'POST',
    headers: falHeaders,
    body: JSON.stringify({
      prompt,
      image_url: imageUrl,
      duration: String(duration),
      aspect_ratio: aspectRatio,
    }),
  });

  const responseText = await response.text();
  let data = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error('Fal.ai returned an invalid response while starting the video job.');
  }
  if (!response.ok) throw new Error(data.detail || `Fal.ai API returned status ${response.status}`);

  await runtimeConfig.taskInfoKv.put(data.request_id, JSON.stringify({
    r2Key: videoKey,
    r2PublicUrl: runtimeConfig.r2PublicUrl
  }));

  return jsonResponse({ success: true, taskId: data.request_id, status: data.status });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
