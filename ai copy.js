// --- START OF FILE ai.js (Final R2 Version) ---

export async function onRequest(context) {
  const { request, env } = context;

  // Standard CORS and method handling
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Runway-Version' } });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Check for all required environment variables
  if (!env.RUNWAYML_API_KEY || !env.R2_PUBLIC_URL || !env.IMAGE_BUCKET || !env.TASK_INFO_KV) {
    const errorMsg = 'CRITICAL FIX REQUIRED: Check Cloudflare project settings for API Key, R2 Public URL, R2 Bucket Binding, and KV Namespace Binding (TASK_INFO_KV).';
    console.error(errorMsg);
    return new Response(JSON.stringify({ success: false, error: errorMsg }), { status: 500 });
  }

  // The single, confirmed working URL for the dev environment
  const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1'; // <-- CHANGED

  try {
    const contentType = request.headers.get('content-type') || '';

    // Handles the initial file upload to start generation
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const prompt = formData.get('prompt');
      const imageFile = formData.get('image');
      const duration = parseInt(formData.get('duration') || '5', 10);
      const ratio = formData.get('ratio') || '1280:720'; // <-- CHANGED: Default ratio
      
      if (!prompt || !imageFile) throw new Error('Request is missing prompt or image file.');

      const imageKey = `uploads/${Date.now()}-${imageFile.name}`;
      await env.IMAGE_BUCKET.put(imageKey, imageFile.stream(), { httpMetadata: { contentType: imageFile.type } });
      const imageUrlForRunway = `${env.R2_PUBLIC_URL}/${imageKey}`;
      
      const videoKey = `videos/${Date.now()}-${imageFile.name.split('.').slice(0, -1).join('.') || imageFile.name}.mp4`;

      const config = {
        body: {
          model: 'gen4_turbo', // <-- CHANGED: Model name
          promptText: prompt,
          promptImage: imageUrlForRunway,
          seed: Math.floor(Math.random() * 4294967295),
          watermark: false,
          duration: duration,
          ratio: ratio
        }
      };
      
      const apiUrl = `${RUNWAY_API_BASE}/image_to_video`; // <-- CHANGED: Simplified URL
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' },
        body: JSON.stringify(config.body),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Runway API returned status ${response.status}`);
      }

      await env.TASK_INFO_KV.put(data.id, JSON.stringify({ videoKey: videoKey, r2PublicUrl: env.R2_PUBLIC_URL }));
      return new Response(JSON.stringify({ success: true, taskId: data.id, status: data.status }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
    
    // Handles subsequent status checks
    else if (contentType.includes('application/json')) {
      const { taskId, action } = await request.json();
      if (action !== 'status' || !taskId) throw new Error('Invalid status check request.');
      
      const statusUrl = `${RUNWAY_API_BASE}/tasks/${taskId}`; // <-- CHANGED: Simplified URL
      const response = await fetch(statusUrl, { headers: { 'Authorization': `Bearer ${env.RUNWAYML_API_KEY}`, 'X-Runway-Version': '2024-11-06' } });
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`Status check failed: ${data.error || response.statusText}`);
      }

      if (data.status === 'SUCCEEDED' && data.output?.[0]) {
        const runwayVideoUrl = data.output[0];
        const taskInfo = await env.TASK_INFO_KV.get(taskId, { type: 'json' });

        if (!taskInfo || !taskInfo.videoKey) {
          throw new Error(`Could not find R2 destination key for task ${taskId}.`);
        }

        const videoResponse = await fetch(runwayVideoUrl);
        if (!videoResponse.ok) {
          throw new Error(`Failed to download generated video from Runway. Status: ${videoResponse.status}`);
        }

        await env.IMAGE_BUCKET.put(taskInfo.videoKey, videoResponse.body, {
          httpMetadata: { contentType: 'video/mp4' }
        });

        const finalVideoUrl = `${taskInfo.r2PublicUrl}/${taskInfo.videoKey}`;
        context.waitUntil(env.TASK_INFO_KV.delete(taskId));

        return new Response(JSON.stringify({ success: true, status: data.status, progress: data.progress, videoUrl: finalVideoUrl }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      // Return progress status if not yet succeeded
      return new Response(JSON.stringify({ success: true, status: data.status, progress: data.progress, videoUrl: null }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } 
    else { throw new Error(`Invalid request content-type.`); }
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}