import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  // Existing State
  const [prompt, setPrompt] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [duration, setDuration] = useState('5');
  const [ratio, setRatio] = useState('1280:720');

  // --- NEW STATE FOR TEXT-TO-IMAGE ---
  const [imagePrompt, setImagePrompt] = useState('');
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [imageGenStatus, setImageGenStatus] = useState('');
  const [generatedImageUrl, setGeneratedImageUrl] = useState(null); // Will hold the R2 URL of the generated image

  const pollIntervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const resetState = (isFullReset = false) => {
    setVideoUrl(null);
    setIsGenerating(false);
    setProgress(0);
    setStatus('');
    setError('');
    if (isFullReset) {
      setImageGenStatus('');
      setGeneratedImageUrl(null);
      removeFile();
    }
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      // Clear any previously generated image
      setGeneratedImageUrl(null);
      setImageGenStatus('');

      const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      if (!validTypes.includes(file.type)) {
        setError('Please select a valid image format (JPEG, PNG, WebP)');
        return;
      }
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (file.size > maxSize) {
        setError('The file is too large. Maximum 10MB allowed.');
        return;
      }
      setSelectedFile(file);
      setError('');
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  const removeFile = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    setGeneratedImageUrl(null);
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  };

  // Generic polling function for both video and image tasks
  const pollForStatus = (taskId, taskType) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const statusResponse = await fetch('/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, action: 'status' }),
        });
        
        const statusData = await statusResponse.json();
        if (!statusResponse.ok || !statusData.success) {
            throw new Error(statusData.error || `Failed to check ${taskType} status`);
        }

        const progressPercentage = (statusData.progress * 100) || 0;
        const currentStatus = `Status: ${statusData.status} (${progressPercentage.toFixed(0)}%)`;

        if (taskType === 'image') {
          setImageGenStatus(currentStatus);
        } else {
          setStatus(currentStatus);
          setProgress(progressPercentage);
        }

        if (statusData.status === 'SUCCEEDED') {
          clearInterval(pollIntervalRef.current);
          if (taskType === 'image' && statusData.imageUrl) {
            setImageGenStatus('Image generated successfully!');
            setPreviewUrl(statusData.imageUrl);
            setGeneratedImageUrl(statusData.imageUrl); // Save the final R2 URL
            setIsGeneratingImage(false);
          } else if (taskType === 'video' && statusData.videoUrl) {
            setVideoUrl(statusData.videoUrl);
            setStatus('Video generation completed!');
            setIsGenerating(false);
          }
        } else if (statusData.status === 'FAILED') {
          throw new Error(statusData.failure?.reason || `${taskType} generation failed`);
        }
      } catch (pollError) {
        setError(pollError.message);
        setIsGenerating(false);
        setIsGeneratingImage(false);
        clearInterval(pollIntervalRef.current);
      }
    }, 4000);
  };

  // --- NEW FUNCTION TO GENERATE IMAGE ---
  const generateImage = async () => {
    if (!imagePrompt.trim()) {
      setError('Please enter a prompt for the image.');
      return;
    }
    resetState(true); // Full reset
    setIsGeneratingImage(true);
    setImageGenStatus('Starting image generation...');

    try {
      const response = await fetch('/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generateImage',
          prompt: imagePrompt,
          ratio: ratio,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to start image generation');
      }

      setImageGenStatus('Image generation started, processing...');
      pollForStatus(data.taskId, 'image');

    } catch (err) {
      setError(err.message);
      setIsGeneratingImage(false);
    }
  };

  const generateVideo = async () => {
    if ((!selectedFile && !generatedImageUrl) || !prompt.trim()) {
      setError('Please provide a source image and a video prompt.');
      return;
    }
    
    resetState(); // Reset video-specific state
    setIsGenerating(true);
    setStatus('Starting video generation job...');

    try {
      let response;
      if (selectedFile) { // User uploaded a file
        const formData = new FormData();
        formData.append('prompt', prompt);
        formData.append('image', selectedFile);
        formData.append('duration', duration);
        formData.append('ratio', ratio);
        response = await fetch('/ai', { method: 'POST', body: formData });
      } else { // User generated an image
        response = await fetch('/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'startVideoFromUrl',
            videoPrompt: prompt,
            imageUrl: generatedImageUrl,
            duration: duration,
            ratio: ratio,
          })
        });
      }

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to start video generation');
      }

      setStatus('Video generation started, processing...');
      pollForStatus(data.taskId, 'video');

    } catch (err) {
      setError(err.message);
      setIsGenerating(false);
    }
  };
  
  const radioGroupStyle = { marginBottom: '20px', border: '1px solid #ccc', padding: '10px', borderRadius: '5px' };
  const radioLabelStyle = { marginRight: '15px', cursor: 'pointer' };
  const sectionStyle = { border: '1px solid #ddd', padding: '15px', borderRadius: '5px', marginBottom: '20px' };
  
  const hasImageSource = selectedFile || generatedImageUrl;

  return (
    <div style={{ padding: '20px', maxWidth: '700px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <h1>Text-to-Image-to-Video with RunwayML</h1>
      
      {/* --- STEP 1: CHOOSE IMAGE SOURCE --- */}
      <h3>Step 1: Provide a Source Image</h3>

      <div style={sectionStyle}>
        <h4>Option A: Generate an Image</h4>
        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', marginBottom: '5px' }}>Image Prompt:</label>
          <input type="text" placeholder="e.g., 'a majestic lion in the savanna'" value={imagePrompt} onChange={e => setImagePrompt(e.target.value)} style={{ width: '100%', padding: '10px', fontSize: '16px', boxSizing: 'border-box' }} />
        </div>
        <button onClick={generateImage} disabled={isGeneratingImage || !imagePrompt.trim()} style={{ padding: '10px 20px', fontSize: '16px', backgroundColor: (isGeneratingImage || !imagePrompt.trim()) ? '#ccc' : '#28a745', color: 'white', border: 'none', cursor: 'pointer' }}>
          {isGeneratingImage ? 'Generating Image...' : 'Generate Image'}
        </button>
        {imageGenStatus && <p style={{ marginTop: '10px', color: '#333' }}>{imageGenStatus}</p>}
      </div>

      <div style={{ textAlign: 'center', margin: '10px 0', fontWeight: 'bold' }}>OR</div>
      
      <div style={sectionStyle}>
        <h4>Option B: Upload an Image</h4>
        <input id="fileInput" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileSelect} style={{ width: '100%' }} />
      </div>

      {previewUrl && (
        <div style={{ marginBottom: '20px', position: 'relative', display: 'inline-block' }}>
          <p><strong>Image Preview:</strong></p>
          <img src={previewUrl} alt="Preview" style={{ maxWidth: '300px', maxHeight: '200px', border: '1px solid #ddd' }} />
          <button onClick={removeFile} style={{ position: 'absolute', top: '5px', right: '5px', background: 'rgba(255,0,0,0.7)', color: 'white', border: 'none', borderRadius: '50%', width: '25px', height: '25px', cursor: 'pointer' }}>×</button>
        </div>
      )}

      {/* --- STEP 2: VIDEO SETTINGS --- */}
      {hasImageSource && (
        <>
          <hr style={{ margin: '30px 0' }}/>
          <h3>Step 2: Generate the Video</h3>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Video Prompt:</label>
            <input type="text" placeholder="e.g., 'camera slowly zooms in'" value={prompt} onChange={e => setPrompt(e.target.value)} style={{ width: '100%', padding: '10px', fontSize: '16px', boxSizing: 'border-box' }} />
          </div>

          <div style={radioGroupStyle}>
            <p style={{ marginTop: 0, fontWeight: 'bold' }}>Duration:</p>
            <label style={radioLabelStyle}><input type="radio" value="5" checked={duration === '5'} onChange={() => setDuration('5')} /> 5 Seconds</label>
            <label style={radioLabelStyle}><input type="radio" value="10" checked={duration === '10'} onChange={() => setDuration('10')} /> 10 Seconds</label>
          </div>
          
          <div style={radioGroupStyle}>
            <p style={{ marginTop: 0, fontWeight: 'bold' }}>Aspect Ratio:</p>
            <label style={radioLabelStyle}><input type="radio" value="1280:720" checked={ratio === '1280:720'} onChange={() => setRatio('1280:720')} /> Landscape (16:9)</label>
            <label style={radioLabelStyle}><input type="radio" value="720:1280" checked={ratio === '720:1280'} onChange={() => setRatio('720:1280')} /> Portrait (9:16)</label>
          </div>

          <button onClick={generateVideo} disabled={isGenerating || isGeneratingImage || !hasImageSource || !prompt.trim()} style={{ padding: '10px 20px', fontSize: '16px', backgroundColor: (isGenerating || isGeneratingImage || !hasImageSource || !prompt.trim()) ? '#ccc' : '#007bff', color: 'white', border: 'none', cursor: 'pointer' }}>
            {isGenerating ? 'Generating Video...' : 'Generate Video'}
          </button>

          {status && (
            <div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#f0f0f0' }}>
              <p>{status}</p>
              {isGenerating && progress > 0 && (
                <div style={{ backgroundColor: '#ddd' }}><div style={{ width: `${progress}%`, height: '20px', backgroundColor: '#007bff', transition: 'width 0.5s ease' }} /></div>
              )}
            </div>
          )}
        </>
      )}

      {error && (<div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#ffebee', color: '#c62828' }}>Error: {error}</div>)}
      
      {videoUrl && (
        <div style={{ marginTop: '20px' }}>
          <h3>Generated Video:</h3>
          <video controls muted autoPlay loop style={{ width: '100%', maxWidth: '500px' }} src={videoUrl}>Your browser does not support the video tag.</video>
        </div>
      )}

      <div style={{ marginTop: '30px', fontSize: '14px', color: '#666' }}>
        <p><strong>Models:</strong> gen4_image (Text-to-Image), gen4_turbo (Image-to-Video)</p>
      </div>
    </div>
  );
}