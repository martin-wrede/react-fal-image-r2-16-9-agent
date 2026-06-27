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

    // ... (multipart/form-data and other cases remain the same) ...

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
    
    else if (contentType.includes('application/json')) {
      const body = await request.json();
      const { action } = body;

      switch (action) {
        case 'generateImage': {
          // This part works, so no changes needed here
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
          await env.TASK_INFO_KV.put(data.id, JSON.stringify({
            type: 'image', r2Key: imageKey, r2PublicUrl: env.R2_PUBLIC_URL
          }));
          return jsonResponse({ success: true, taskId: data.id });
        }
        
        case 'startVideoFromUrl': {
          // This part works, so no changes needed here
          const { videoPrompt, imageUrl, duration, ratio } = body;
          if (!videoPrompt || !imageUrl) throw new Error("Missing video prompt or image URL.");
          return await startImageToVideoJob(imageUrl, videoPrompt, parseInt(duration || '5', 10), ratio || '1280:720', 'generated-image', env);
        }

        // --- B3. Poll for status of any task (WITH ADDED LOGGING) ---
        case 'status': {
          const { taskId } = body;
          if (!taskId) throw new Error('Invalid status check request.');
          
          const statusUrl = `${RUNWAY_API_BASE}/tasks/${taskId}`;
          const response = await fetch(statusUrl, { headers: { ...COMMON_HEADERS, 'Content-Type': undefined } });
          const data = await response.json();
          
          if (!response.ok) throw new Error(`Status check failed: ${data.error || response.statusText}`);

          if (data.status === 'SUCCEEDED' && data.output?.[0]) {
            // --- START OF DEBUG LOGS ---
            console.log(`[${taskId}] Task SUCCEEDED. Preparing to save output.`);
            const taskInfo = await env.TASK_INFO_KV.get(taskId, { type: 'json' });

            if (!taskInfo || !taskInfo.r2Key) {
              console.error(`[${taskId}] CRITICAL ERROR: Could not find R2 destination key in KV.`);
              throw new Error(`Could not find R2 destination key for task ${taskId}.`);
            }
            console.log(`[${taskId}] Found KV info. Type: ${taskInfo.type}, R2 Key: ${taskInfo.r2Key}`);
            
            const runwayOutputUrl = data.output[0];
            console.log(`[${taskId}] Attempting to download from Runway URL: ${runwayOutputUrl}`);
            
            const outputResponse = await fetch(runwayOutputUrl);
            
            if (!outputResponse.ok) {
              console.error(`[${taskId}] FAILED to download from Runway. Status: ${outputResponse.status} ${outputResponse.statusText}`);
              throw new Error(`Failed to download generated content from Runway. Status: ${outputResponse.status}`);
            }
            console.log(`[${taskId}] Download from Runway successful. Status: ${outputResponse.status}`);
            
            const contentType = taskInfo.type === 'image' ? 'image/png' : 'video/mp4';
            console.log(`[${taskId}] Attempting to save to R2 with Content-Type: ${contentType}`);

            await env.IMAGE_BUCKET.put(taskInfo.r2Key, outputResponse.body, {
              httpMetadata: { contentType }
            });
            console.log(`[${taskId}] R2 'put' operation completed successfully.`);
            // --- END OF DEBUG LOGS ---

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
    console.error('Caught a top-level error:', error.message); // Added more context to error logging
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

// ... (helper functions remain the same) ...
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

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}