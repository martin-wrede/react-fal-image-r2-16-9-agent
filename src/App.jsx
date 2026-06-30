import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  const [prompt, setPrompt] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [duration, setDuration] = useState('5');
  const [ratio, setRatio] = useState('16:9');

  const pollIntervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  const resetState = () => {
    setVideoUrl(null);
    setIsGenerating(false);
    setProgress(0);
    setStatus('');
    setError('');
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setError('Please select a valid image format (JPEG, PNG, WebP)');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File too large. Maximum 10MB allowed.');
      return;
    }
    setSelectedFile(file);
    setError('');
    setPreviewUrl(URL.createObjectURL(file));
  };

  const removeFile = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  };

  const pollForStatus = (taskId) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const statusResponse = await fetch('/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, action: 'status' }),
        });

        const statusData = await statusResponse.json();
        if (!statusResponse.ok || !statusData.success) {
          throw new Error(statusData.error || 'Failed to check status');
        }

        const progressPercentage = (statusData.progress * 100) || 0;
        setStatus(`Status: ${statusData.status} (${progressPercentage.toFixed(0)}%)`);
        setProgress(progressPercentage);

        if (statusData.status === 'SUCCEEDED') {
          clearInterval(pollIntervalRef.current);
          setVideoUrl(statusData.videoUrl);
          setStatus('Video generation complete!');
          setIsGenerating(false);
        } else if (statusData.status === 'FAILED') {
          throw new Error('Video generation failed.');
        }
      } catch (pollError) {
        clearInterval(pollIntervalRef.current);
        setError(pollError.message);
        setIsGenerating(false);
      }
    }, 5000);
  };

  const generateVideo = async () => {
    if (!selectedFile || !prompt.trim()) {
      setError('Please provide an image and a video prompt.');
      return;
    }

    resetState();
    setIsGenerating(true);
    setStatus('Starting video generation...');

    try {
      const formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('image', selectedFile);
      formData.append('duration', duration);
      formData.append('ratio', ratio);

      const response = await fetch('/ai', { method: 'POST', body: formData });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to start video generation');
      }

      setStatus('Video queued, processing...');
      pollForStatus(data.taskId);

    } catch (err) {
      setError(err.message);
      setIsGenerating(false);
    }
  };

  const radioGroupStyle = { marginBottom: '20px', border: '1px solid #ccc', padding: '10px', borderRadius: '5px' };
  const radioLabelStyle = { marginRight: '15px', cursor: 'pointer' };

  return (
    <div style={{ padding: '20px', maxWidth: '700px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <h1>Image-to-Video — Fal.ai Kling v2.5 Pro</h1>

      <h3>Step 1: Upload a Source Image</h3>
      <input
        id="fileInput"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileSelect}
        style={{ width: '100%', marginBottom: '10px' }}
      />

      {previewUrl && (
        <div style={{ marginBottom: '20px', position: 'relative', display: 'inline-block' }}>
          <p><strong>Preview:</strong></p>
          <img src={previewUrl} alt="Preview" style={{ maxWidth: '300px', maxHeight: '200px', border: '1px solid #ddd', display: 'block' }} />
          <button
            onClick={removeFile}
            style={{ position: 'absolute', top: '30px', right: '5px', background: 'rgba(255,0,0,0.7)', color: 'white', border: 'none', borderRadius: '50%', width: '25px', height: '25px', cursor: 'pointer' }}
          >×</button>
        </div>
      )}

      {selectedFile && (
        <>
          <hr style={{ margin: '30px 0' }} />
          <h3>Step 2: Configure & Generate Video</h3>

          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Video Prompt:</label>
            <input
              type="text"
              placeholder="e.g., 'camera slowly zooms in'"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              style={{ width: '100%', padding: '10px', fontSize: '16px', boxSizing: 'border-box' }}
            />
          </div>

          <div style={radioGroupStyle}>
            <p style={{ marginTop: 0, fontWeight: 'bold' }}>Duration:</p>
            <label style={radioLabelStyle}>
              <input type="radio" value="5" checked={duration === '5'} onChange={() => setDuration('5')} /> 5 Seconds
            </label>
            <label style={radioLabelStyle}>
              <input type="radio" value="10" checked={duration === '10'} onChange={() => setDuration('10')} /> 10 Seconds
            </label>
          </div>

          <div style={radioGroupStyle}>
            <p style={{ marginTop: 0, fontWeight: 'bold' }}>Aspect Ratio:</p>
            <label style={radioLabelStyle}>
              <input type="radio" value="16:9" checked={ratio === '16:9'} onChange={() => setRatio('16:9')} /> Landscape (16:9)
            </label>
            <label style={radioLabelStyle}>
              <input type="radio" value="9:16" checked={ratio === '9:16'} onChange={() => setRatio('9:16')} /> Portrait (9:16)
            </label>
          </div>

          <button
            onClick={generateVideo}
            disabled={isGenerating || !prompt.trim()}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              backgroundColor: (isGenerating || !prompt.trim()) ? '#ccc' : '#007bff',
              color: 'white',
              border: 'none',
              cursor: (isGenerating || !prompt.trim()) ? 'default' : 'pointer'
            }}
          >
            {isGenerating ? 'Generating Video...' : 'Generate Video'}
          </button>

          {status && (
            <div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#f0f0f0' }}>
              <p style={{ margin: 0 }}>{status}</p>
              {isGenerating && (
                <div style={{ backgroundColor: '#ddd', marginTop: '8px' }}>
                  <div style={{ width: `${progress || 10}%`, height: '20px', backgroundColor: '#007bff', transition: 'width 0.5s ease' }} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <div style={{ marginTop: '20px', padding: '10px', backgroundColor: '#ffebee', color: '#c62828' }}>
          Error: {error}
        </div>
      )}

      {videoUrl && (
        <div style={{ marginTop: '20px' }}>
          <h3>Generated Video:</h3>
          <video controls muted autoPlay loop style={{ width: '100%', maxWidth: '500px' }} src={videoUrl}>
            Your browser does not support the video tag.
          </video>
          <p>
            <a href={videoUrl} download>Download video</a>
          </p>
        </div>
      )}

      <div style={{ marginTop: '30px', fontSize: '14px', color: '#666' }}>
        <p><strong>Model:</strong> Kling Video v2.5 Turbo Pro — Image-to-Video — HD/FullHD &mdash; 5s ($0.35) or 10s ($0.70)</p>
      </div>
    </div>
  );
}
