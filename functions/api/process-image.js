// functions/api/process-image.js
// Cloudflare Pages Function — image-to-image via fal.ai nano-banana-2
//
// Takes a raw news image URL, applies 1960s retro aesthetic via fal.ai,
// removes logos/watermarks, stores the result in R2.
//
// Required bindings (Cloudflare Pages → Settings → Functions):
//   IMAGE_BUCKET   — R2 bucket binding
//   R2_PUBLIC_URL  — env var: public R2 base URL
//   FAL_API_KEY    — env var: fal.ai API key
//
// POST /api/process-image
// Body: { imageUrl, headline, storyIndex, episodeDate }
// Response: { processedImageUrl, r2Key }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FAL_MODEL = 'fal-ai/nano-banana-2/edit';

// 1960s retro aesthetic prompt — applied to every news image
const STYLE_PROMPT = [
  'Transform to 1960s Life Magazine editorial photography.',
  'Kodachrome film stock, warm analog colors, slight grain.',
  'Mid-century modern composition, dramatic directional lighting.',
  'Remove all logos, watermarks, text overlays, and modern branding.',
  'Retain the scene and subjects but render in retro-futuristic 1960s style.',
  'Harvest gold, burnt orange, teal color palette.',
  'Cinematic depth of field, vintage photojournalism aesthetic.',
].join(' ');

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }
  if (request.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  if (!env.FAL_API_KEY)    return jsonError('FAL_API_KEY not configured', 500);
  if (!env.IMAGE_BUCKET)   return jsonError('IMAGE_BUCKET binding missing', 500);
  if (!env.R2_PUBLIC_URL)  return jsonError('R2_PUBLIC_URL not configured', 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { imageUrl, headline = 'story', storyIndex = 0, episodeDate } = body;
  if (!imageUrl) return jsonError('imageUrl is required', 400);

  // ── Step 1: Submit to fal.ai nano-banana-2 ───────────────────────────────
  let falTaskId;
  try {
    const falRes = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${env.FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: imageUrl,
        prompt: STYLE_PROMPT,
        negative_prompt: 'logos, watermarks, text, modern design, contemporary style, digital artifacts',
        num_inference_steps: 30,
        guidance_scale: 7.5,
        strength: 0.65,  // 0 = keep original structure, 1 = full redraw
      }),
    });

    const falData = await falRes.json();
    if (!falRes.ok) throw new Error(falData.detail || `fal.ai error: ${falRes.status}`);
    falTaskId = falData.request_id;
  } catch (err) {
    return jsonError(`fal.ai submission failed: ${err.message}`, 502);
  }

  // ── Step 2: Poll fal.ai for result (max 52s to stay under CF timeout) ────
  const slug = headline.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 25);
  const r2Key = episodeDate
    ? `processed-images/${episodeDate}/${String(storyIndex).padStart(2, '0')}-${slug}.jpg`
    : `processed-images/${Date.now()}-${slug}.jpg`;

  const deadline = Date.now() + 52_000;
  let processedUrl = null;

  while (Date.now() < deadline) {
    await sleep(3000);

    try {
      const statusRes = await fetch(
        `https://queue.fal.run/${FAL_MODEL}/requests/${falTaskId}/status`,
        { headers: { 'Authorization': `Key ${env.FAL_API_KEY}` } }
      );
      const statusData = await statusRes.json();

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(
          `https://queue.fal.run/${FAL_MODEL}/requests/${falTaskId}`,
          { headers: { 'Authorization': `Key ${env.FAL_API_KEY}` } }
        );
        const result = await resultRes.json();
        processedUrl = result?.images?.[0]?.url || result?.image?.url || null;
        if (!processedUrl) throw new Error('fal.ai returned no image URL');
        break;
      }

      if (statusData.status === 'FAILED') {
        throw new Error(`fal.ai task failed: ${statusData.error || 'unknown'}`);
      }
    } catch (err) {
      return jsonError(`fal.ai polling error: ${err.message}`, 502);
    }
  }

  if (!processedUrl) {
    return jsonError('fal.ai timed out — try again or increase timeout', 504);
  }

  // ── Step 3: Download processed image and store in R2 ─────────────────────
  try {
    const imgRes = await fetch(processedUrl);
    if (!imgRes.ok) throw new Error(`Failed to fetch processed image: ${imgRes.status}`);

    await env.IMAGE_BUCKET.put(r2Key, imgRes.body, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
  } catch (err) {
    return jsonError(`R2 storage failed: ${err.message}`, 500);
  }

  const finalUrl = `${env.R2_PUBLIC_URL}/${r2Key}`;
  console.log(`[process-image] Story ${storyIndex} processed → ${r2Key}`);

  return jsonOk({
    success: true,
    processedImageUrl: finalUrl,
    r2Key,
    falTaskId,
    headline,
    storyIndex,
    episodeDate,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
