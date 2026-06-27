export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Runway-Version' } });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!env.RUNWAYML_API_KEY || !env.R2_PUBLIC_URL || !env.IMAGE_BUCKET || !env.TASK_INFO_KV) {
    const errorMsg = 'CRITICAL FIX REQUIRED: Check Cloudflare project settings for API Key, R2 Public URL, R2 Bucket Binding, and KV Namespace Binding (TASK_INFO_KV).';
    console.error(errorMsg);
    return new Response(JSON.stringify({ success: false, error: errorMsg }), { status: 500 });
  }

  const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
  const COMMON_HEADERS = {
    'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`,
    'X-Runway-Version': '2024-11-06',
    'Content-Type': 'application/json'
  };

  try {
    const contentType = request.headers.get('content-type') || '';

    // --- A. Handles initial video generation from an UPLOADED file ---
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const prompt = formData.get('prompt');
      const imageFile = formData.get('image');
      const duration = parseInt(formData.get('duration') || '5', 10);
      const ratio = formData.get('ratio') || '1280:720';
      
      if (!prompt || !imageFile) throw new Error('Request is missing prompt or image file.');

      const imageKey = `uploads/${Date.now()}-${imageFile.name}`;
      await env.IMAGE_BUCKET.put(imageKey, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
      const imageUrlForRunway = `${env.R2_PUBLIC_URL}/${imageKey}`;
      
      return await startImageToVideoJob(imageUrlForRunway, prompt, duration, ratio, imageFile.name, env);
    }
    
    // --- B. Handles JSON-based requests (status checks, image generation, video from URL) ---
    else if (contentType.includes('application/json')) {
      const body = await request.json();
      const { action } = body;

      switch (action) {
        // --- B1. Start text-to-image job ---
        case 'generateImage': {
          const { prompt, ratio } = body;
          if (!prompt) throw new Error('Image prompt is missing.');

          const imageKey = `generated-images/${Date.now()}-${prompt.substring(0, 20).replace(/\s/g, '_')}.png`;
          
          const runwayResponse = await fetch(`${RUNWAY_API_BASE}/text_to_image`, {
            method: 'POST',
            headers: COMMON_HEADERS,
            body: JSON.stringify({
              model: 'gen4_image',
              promptText: prompt,
              ratio: ratio || '1280:720',
              seed: Math.floor(Math.random() * 4294967295),
            }),
          });
          
          const data = await runwayResponse.json();
          if (!runwayResponse.ok) throw new Error(data.error || `Runway T2I API error: ${runwayResponse.status}`);
          
          // Store task info for polling
          await env.TASK_INFO_KV.put(data.id, JSON.stringify({
            type: 'image',
            r2Key: imageKey,
            r2PublicUrl: env.R2_PUBLIC_URL
          }));

          return jsonResponse({ success: true, taskId: data.id });
        }
        
        // --- B2. Start video generation from a PRE-EXISTING image URL ---
        case 'startVideoFromUrl': {
          const { videoPrompt, imageUrl, duration, ratio } = body;
          if (!videoPrompt || !imageUrl) throw new Error("Missing video prompt or image URL.");
          return await startImageToVideoJob(imageUrl, videoPrompt, parseInt(duration || '5', 10), ratio || '1280:720', 'generated-image', env);
        }

        // --- B3. Poll for status of any task ---
        case 'status': {
          const { taskId } = body;
          if (!taskId) throw new Error('Invalid status check request.');
          
          const statusUrl = `${RUNWAY_API_BASE}/tasks/${taskId}`;
          const response = await fetch(statusUrl, { headers: { ...COMMON_HEADERS, 'Content-Type': undefined } }); // Don't send Content-Type on GET-like requests
          const data = await response.json();
          
          if (!response.ok) throw new Error(`Status check failed: ${data.error || response.statusText}`);

          if (data.status === 'SUCCEEDED' && data.output?.[0]) {
            const taskInfo = await env.TASK_INFO_KV.get(taskId, { type: 'json' });
            if (!taskInfo || !taskInfo.r2Key) throw new Error(`Could not find R2 destination for task ${taskId}.`);

            const runwayOutputUrl = data.output[0];
            const outputResponse = await fetch(runwayOutputUrl);
            if (!outputResponse.ok) throw new Error(`Failed to download from Runway. Status: ${outputResponse.status}`);
            
            const contentType = taskInfo.type === 'image' ? 'image/png' : 'video/mp4';
            await env.IMAGE_BUCKET.put(taskInfo.r2Key, outputResponse.body, { httpMetadata: { contentType } });
            
            const finalUrl = `${taskInfo.r2PublicUrl}/${taskInfo.r2Key}`;
            context.waitUntil(env.TASK_INFO_KV.delete(taskId));
            
            const successPayload = { success: true, status: data.status, progress: data.progress };
            if (taskInfo.type === 'image') {
              successPayload.imageUrl = finalUrl;
            } else {
              successPayload.videoUrl = finalUrl;
            }
            return jsonResponse(successPayload);
          }

          // Return progress status if not yet succeeded
          return jsonResponse({ success: true, status: data.status, progress: data.progress });
        }
        default:
          throw new Error('Invalid action specified.');
      }
    } 
    else { throw new Error(`Invalid request content-type.`); }
  } catch (error) {
    console.error(error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

// Helper function to start the image-to-video job
async function startImageToVideoJob(imageUrl, prompt, duration, ratio, originalName, env) {
  const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
  const videoKey = `videos/${Date.now()}-${originalName.split('.').slice(0, -1).join('.') || originalName}.mp4`;

  const response = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gen4_turbo',
      promptText: prompt,
      promptImage: imageUrl,
      seed: Math.floor(Math.random() * 4294967295),
      watermark: false,
      duration: duration,
      ratio: ratio
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Runway I2V API returned status ${response.status}`);
  
  await env.TASK_INFO_KV.put(data.id, JSON.stringify({
    type: 'video',
    r2Key: videoKey,
    r2PublicUrl: env.R2_PUBLIC_URL
  }));

  return jsonResponse({ success: true, taskId: data.id, status: data.status });
}

// Helper for consistent JSON responses
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}