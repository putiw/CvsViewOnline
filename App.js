import { StatusBar } from 'expo-status-bar';
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform, ScrollView } from 'react-native';
import { Asset } from 'expo-asset';
import { loadNifti } from './utils/niftiLoader';
import { findConnectedComponents } from './utils/lesionAnalysis';
import { zNormalize, calculateContrastPercentiles } from './utils/imageProcessing';
import { renderSliceToDataURL } from './utils/renderer';
import SliceViewer from './components/SliceViewer';
import Slider from '@react-native-community/slider';
import MultiSlider from '@ptomasroos/react-native-multi-slider';
import DataLoadModal from './components/DataLoadModal';
import "./global.css"
// Mapping for sample filenames using require for Metro bundling
// Mapping for sample filenames using require for Metro bundling - DISABLED
// const SAMPLE_FILES = {
//   flairStar: require('./assets/sample_data/sub-dimah_ses-01_space-swi_FLAIRSTAR.nii.gz'),
//   swi: require('./assets/sample_data/sub-dimah_ses-01_swi.nii.gz'),
//   flair: require('./assets/sample_data/sub-dimah_ses-01_space-swi_FLAIR.nii.gz'),
//   phase: require('./assets/sample_data/sub-dimah_ses-01_part-phase_swi.nii.gz'),
//   lesion: require('./assets/sample_data/sub-dimah_ses-01_space-swi_desc-lesion_mask.nii.gz'),
// };

export default function App() {
  const [loading, setLoading] = useState(false);
  const [volumes, setVolumes] = useState({});
  const [lesions, setLesions] = useState([]);
  const [dims, setDims] = useState([256, 256, 256]);
  const [pixDims, setPixDims] = useState([1, 1, 1]); // new state for voxel dimensions

  // State
  const [modality, setModality] = useState('flairStar');
  const [lesionIndex, setLesionIndex] = useState(0);
  const [showMask, setShowMask] = useState(true);
  const [showLoadModal, setShowLoadModal] = useState(false); // Data Load Modal
  const [lesionScores, setLesionScores] = useState({});
  const [lesionPRL, setLesionPRL] = useState({}); // Map index -> isPRL

  // Coordinates (voxel space)
  const [coords, setCoords] = useState({ x: 0, y: 0, z: 0 });
  const [lesionCoords, setLesionCoords] = useState({}); // Persistence: { index: {x,y,z} }
  const [zoom, setZoom] = useState(0.5);

  // Contrast Settings (Per Modality)
  const [contrastSettings, setContrastSettings] = useState({
    flairStar: { min: -1.5, max: 1.96 },
    swi: { min: -1.5, max: 1.96 },
    flair: { min: -1.5, max: 1.96 },
    phase: { min: -1.5, max: 1.96 },
  });

  // Slider Limits (Min/Max range of the slider itself)
  const [contrastLimits, setContrastLimits] = useState({
    flairStar: { min: -5, max: 10 },
    swi: { min: -5, max: 10 },
    flair: { min: -5, max: 10 },
    phase: { min: -3142, max: 3142 }, // Raw Phase can be large
  });

  const [veinLikelihood, setVeinLikelihood] = useState(0);
  const [fileMetadata, setFileMetadata] = useState({});

  // Helper to get current contrast
  const currentMin = contrastSettings[modality]?.min ?? -1.5;
  const currentMax = contrastSettings[modality]?.max ?? 1.96;

  const setWindowMin = (val) => {
    setContrastSettings(prev => ({
      ...prev,
      [modality]: { ...prev[modality], min: val }
    }));
  };

  const setWindowMax = (val) => {
    setContrastSettings(prev => ({
      ...prev,
      [modality]: { ...prev[modality], max: val }
    }));
  };

  // Keyboard Shortcuts
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleKeyDown = (e) => {
      // Ignore if input is focused (though we don't have text inputs yet)
      switch (e.key) {
        case '1': setModality('flairStar'); break;
        case '2': setModality('swi'); break;
        case '3': setModality('flair'); break;
        case '4': setModality('phase'); break;
        case 'x': setShowMask(prev => !prev); break;
        case 'ArrowLeft': handlePrevLesion(); break;
        case 'ArrowRight': handleNextLesion(); break;
        case 'ArrowUp': setZoom(z => Math.min(10, z + 0.1)); break;
        case 'ArrowDown': setZoom(z => Math.max(0.2, z - 0.1)); break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lesionIndex, lesions, modality]);

  const loadData = async () => {
    alert("Sample data has been disabled. Please use 'Load Data' to upload your own files.");
  };

  const handleUpdateCoords = (newCoordsFunc) => {
    setCoords(prev => {
      const next = typeof newCoordsFunc === 'function' ? newCoordsFunc(prev) : newCoordsFunc;
      // Search index is 0-based, same as lesionIndex
      setLesionCoords(prevMap => ({
        ...prevMap,
        [lesionIndex]: next
      }));
      return next;
    });
  };

  const jumpToLesion = (idx) => {
    if (idx < 0 || idx >= lesions.length) return;
    setLesionIndex(idx);

    // Check persistence
    if (lesionCoords[idx]) {
      console.log(`Restoring saved view for lesion ${idx + 1}`);
      setCoords(lesionCoords[idx]);
    } else {
      const l = lesions[idx];
      console.log(`Resetting view for lesion ${idx + 1}`);
      setCoords({ x: l.x, y: l.y, z: l.z });
    }
    setVeinLikelihood(lesionScores[idx] || 0);
  };

  // Callback from DataLoadModal
  const handleDataLoad = async (buffers, metadata, statusCb) => {
    // Handle optional metadata/callback args
    let cb = statusCb;
    if (typeof metadata === 'function') {
      cb = metadata;
      metadata = {};
    }
    setFileMetadata(metadata || {});
    setLoading("Parsing NIfTI headers...");
    try {
      // Re-use logic similar to loadData but with provided buffers
      // Buffers: { flairStar, lesion, swi, flair, phase } (all ArrayBuffers)

      const parse = (buf) => buf ? loadNifti(buf) : null;

      setLoading("Parsing NIfTI headers...");
      await new Promise(r => setTimeout(r, 20));

      const vFlairStar = parse(buffers.flairStar);
      const vLesion = parse(buffers.lesion);
      const vSwi = parse(buffers.swi);
      const vFlair = parse(buffers.flair);
      const vPhase = parse(buffers.phase);

      if (!vFlairStar || !vLesion) throw new Error("Missing Core Files");

      // Update Dims
      setDims(vFlairStar.header.dims.slice(1, 4));
      setPixDims(vFlairStar.header.pixDims ? vFlairStar.header.pixDims.slice(1, 4) : [1, 1, 1]);

      // Process
      setLoading("Normalizing volumes...");
      await new Promise(r => setTimeout(r, 20));

      const normFlairStar = zNormalize(vFlairStar.data);
      const normSwi = vSwi ? zNormalize(vSwi.data) : null;
      const normFlair = vFlair ? zNormalize(vFlair.data) : null;
      const rawPhase = vPhase ? vPhase.data : null;

      // Percs
      const flairStarPerc = calculateContrastPercentiles(normFlairStar, 2.0, 99.5);
      const swiPerc = vSwi ? calculateContrastPercentiles(normSwi, 2.0, 99.5) : { min: -1.5, max: 1.96 };
      const flairPerc = vFlair ? calculateContrastPercentiles(normFlair, 2.0, 99.5) : { min: -1.5, max: 1.96 };

      // Lesion Analysis
      setLoading("Analyzing lesions (CCA)...");
      await new Promise(r => setTimeout(r, 20));

      console.log("Analyzing new lesions...");
      const analysis = await findConnectedComponents(vLesion.data, vFlairStar.dims, (msg) => setLoading(msg));
      setLesions(analysis.lesions);

      setLoading("Finalizing...");
      await new Promise(r => setTimeout(r, 20));

      setVolumes({
        flairStar: normFlairStar,
        phase: rawPhase,
        swi: normSwi,
        flair: normFlair,
        lesion: analysis.labeledMask
      });

      // Reset Persistence
      setLesionCoords({});
      setLesionScores({});
      setLesionPRL({});

      // Limits
      setContrastLimits({
        flairStar: calculateContrastPercentiles(normFlairStar, 0.01, 99.99),
        swi: vSwi ? calculateContrastPercentiles(normSwi, 0.01, 99.99) : { min: -5, max: 10 },
        flair: vFlair ? calculateContrastPercentiles(normFlair, 0.01, 99.99) : { min: -5, max: 10 },
        phase: vPhase ? calculateContrastPercentiles(vPhase.data, 0.01, 99.99) : { min: -1000, max: 1000 }
      });

      setContrastSettings({
        flairStar: flairStarPerc,
        swi: swiPerc,
        flair: flairPerc,
        phase: { min: -500, max: 500 }
      });

      // Initial Coords
      if (analysis.lesions.length > 0) {
        setLesionIndex(0);
        const first = analysis.lesions[0];
        setCoords({ x: first.x, y: first.y, z: first.z });
      }

    } catch (e) {
      console.error(e);
      alert("Error processing loaded data: " + e.message);
    } finally {
      setLoading(false);
    }
  };


  const handleNextLesion = () => {
    if (lesions.length === 0) return;
    const nextIdx = (lesionIndex + 1) % lesions.length;
    jumpToLesion(nextIdx);
  };

  const handlePrevLesion = () => {
    if (lesions.length === 0) return;
    const prevIdx = (lesionIndex - 1 + lesions.length) % lesions.length;
    jumpToLesion(prevIdx);
  };

  const updateScore = (val) => {
    setVeinLikelihood(val);
    setLesionScores(prev => ({ ...prev, [lesionIndex]: val }));
  };

  // --- Hoisted Stats Logic ---
  const validLesionsCount = Object.values(lesionScores).filter(s => s >= 0.5).length;
  const prlLesionsCount = Object.values(lesionPRL).filter(p => p).length;
  const totalVolume = lesions.reduce((acc, l) => acc + (l.volume * pixDims[0] * pixDims[1] * pixDims[2]), 0) / 1000;
  // ---------------------------

  const generateReport = async () => {
    if (Platform.OS !== 'web') {
      alert("Notice: PDF Generation is web-only for this demo.");
      return;
    }

    // Get CVS+ lesions
    const cvsLesions = lesions.filter((_, idx) => lesionScores[idx] >= 0.5);

    // Generate Text Report Content
    const reportDate = new Date().toLocaleString();

    const textReportBody = [
      "CvsView Session Report",
      "======================",
      `Date: ${reportDate}`,
      "",
      "Session Statistics",
      "------------------",
      `Total Lesions: ${lesions.length}`,
      `Total Vol (ml): ${totalVolume.toFixed(2)}`,
      `CVS+ Lesions: ${validLesionsCount}`,
      `PRL+ Lesions: ${prlLesionsCount}`,
      "",
      "File Information",
      "----------------",
      `FLAIRSTAR Path: ${fileMetadata.flairStarPath || 'N/A'}`
    ].join('\r\n');

    const textReportUri = `data:text/plain;charset=utf-8,${encodeURIComponent(textReportBody)}`;

    // Create report HTML
    let reportHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>CvsView Report</title>
         <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');

          body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: #0f172a; color: #f1f5f9; margin: 0; padding: 40px; }
          
          .container { max-width: 900px; margin: 0 auto; background: #1e293b; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.5); border: 1px solid #334155; }

          @media print {
            body { background: white; color: black; padding: 0; }
            .container { box-shadow: none; max-width: none; padding: 20px; background: white; border: none; }
            .no-print { display: none !important; }
            .lesion { break-inside: avoid; page-break-inside: avoid; border: 1px solid #ccc !important; }
            h1, h2, .stat-label, .stat-value, .lesion-title { color: black !important; }
            .stats-card { background: white !important; border: 1px solid #ccc !important; }
            .stat-item { border-bottom: 1px solid #eee !important; }
            .img-card { background: white !important; border: 1px solid #ccc !important; }
          }
          
          h1 { color: #f8fafc; font-size: 30px; font-weight: 700; border-bottom: 2px solid #334155; padding-bottom: 20px; margin-bottom: 30px; letter-spacing: -0.5px; }
          h2 { color: #e2e8f0; font-size: 20px; font-weight: 600; margin-top: 40px; margin-bottom: 15px; }
          
          .stats-card { background: #0f172a; border-radius: 8px; padding: 24px; border: 1px solid #334155; margin-bottom: 30px; }
          .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 16px; }
          .stat-item { display: flex; justify-content: space-between; border-bottom: 1px solid #1e293b; padding-bottom: 8px; }
          .stat-label { color: #94a3b8; font-weight: 500; }
          .stat-value { color: #f1f5f9; font-weight: 600; }

          .lesion { margin-bottom: 50px; border: 1px solid #334155; border-radius: 8px; padding: 24px; background: #0f172a; }
          .lesion-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #1e293b; }
          .lesion-title { font-size: 22px; font-weight: 700; color: #60a5fa; }
          .lesion-score { font-size: 18px; font-weight: 700; color: #4ade80; background: rgba(74, 222, 128, 0.1); padding: 4px 12px; rounded: 9999px; border-radius: 20px; }
          .lesion-meta { font-size: 14px; color: #94a3b8; margin-top: 4px; }

          .image-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px; }
          .grid-column { display: flex; flex-direction: column; gap: 8px; }
          
          .axis-label { text-align: center; font-size: 12px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }

          .img-card { border: 1px solid #1e293b; padding: 4px; background: #000; border-radius: 6px; box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.2); }
          .img-card img { width: 100%; height: auto; display: block; border-radius: 2px; }
          .img-meta { font-size: 11px; color: #64748b; margin-top: 4px; text-align: center; font-family: sans-serif; }

          .row-title { font-size: 12px; font-weight: 700; color: #94a3b8; margin: 16px 0 8px; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
          .row-title::after { content: ''; flex: 1; height: 1px; background: #334155; }

          .btn { display: inline-block; padding: 10px 20px; border-radius: 6px; font-weight: 600; text-decoration: none; font-size: 14px; cursor: pointer; border: none; transition: opacity 0.2s; }
          .btn-primary { background: #3b82f6; color: white; }
          .btn:hover { opacity: 0.9; }
        </style>
      </head>
      <body>
        <div class="container">
            <div class="no-print" style="margin-bottom: 30px;">
               <a href="${textReportUri}" download="cvsview_report.txt" class="btn btn-primary">Download Text Report</a>
            </div>

            <h1>CvsView Session Report</h1>
            
            <div class="stats-card">
              <div class="stats-grid">
                 <div class="stat-item"><span class="stat-label">Total Lesions</span> <span class="stat-value">${lesions.length}</span></div>
                 <div class="stat-item"><span class="stat-label">Total Volume</span> <span class="stat-value">${totalVolume.toFixed(2)} ml</span></div>
                 <div class="stat-item"><span class="stat-label">CVS+ Lesions</span> <span class="stat-value">${validLesionsCount}</span></div>
                 <div class="stat-item"><span class="stat-label">PRL+ Lesions</span> <span class="stat-value">${prlLesionsCount}</span></div>
              </div>
            </div>

            <h2>Lesion Analysis</h2>
    `;

    // ... (Loop logic remains) ...

    // Inside loop:
    /* 
       New Structure:
       <div class="lesion">
         <Header>
         <div class="axis-container">
           <div class="axis-column">
              <div class="axis-title">Sagittal</div>
              <div class="img-wrapper"><span class="img-label">Zoom</span> <img class="zoom-img" src="..."></div>
              <div class="img-wrapper"><span class="img-label">Full</span> <img class="full-img" src="..."></div>
           </div>
           ... Coronal ... Axial ...
         </div>
       </div>
    */


    // Identify lesions of interest (CVS+ > 0.5 OR PRL+)
    const interestIndices = lesions.map((l, i) => {
      const isCvs = (lesionScores[i] || 0) > 0.5;
      const isPrl = !!lesionPRL[i];
      if (isCvs || isPrl) return i;
      return -1;
    }).filter(i => i !== -1);

    for (let i = 0; i < interestIndices.length; i++) {
      const lesionIdx = interestIndices[i];
      const l = lesions[lesionIdx];
      const isCvs = (lesionScores[lesionIdx] || 0) > 0.5;
      const isPrl = !!lesionPRL[lesionIdx];

      // Determine Render Tasks (CVS First!)
      const renderTasks = [];

      if (isPrl && isCvs) {
        // Dual Modality: Show CVS (FLAIRSTAR) first, then PRL (Phase)
        renderTasks.push({ modality: 'flairStar', min: currentMin, max: currentMax, label: 'CVS check', type: 'cvs' });
        renderTasks.push({ modality: 'phase', min: -500, max: 500, label: 'PRL check', type: 'prl' });
      } else if (isPrl) {
        renderTasks.push({ modality: 'phase', min: -500, max: 500, label: 'PRL', type: 'prl' });
      } else {
        // CVS only
        renderTasks.push({ modality: 'flairStar', min: currentMin, max: currentMax, label: 'CVS', type: 'cvs' });
      }

      // Generate HTML for each task
      for (const task of renderTasks) {
        // Use persisted view if available, otherwise default center
        const savedCoords = lesionCoords[lesionIdx] || { x: l.x, y: l.y, z: l.z };

        const capture = (axis, isZoomed, isFull) => {
          return renderSliceToDataURL({
            volumes: volumes,
            modality: task.modality,
            axis: axis,
            sliceCoords: savedCoords,
            dims: dims,
            pixDims: pixDims,
            fovZoom: isZoomed ? topZoom : null,
            boxZoom: isFull ? topZoom : null,
            showMask: false,
            windowMin: task.min,
            windowMax: task.max
          });
        };

        const imgSagZ = capture('x', true, false);
        const imgCorZ = capture('y', true, false);
        const imgAxZ = capture('z', true, false);

        const imgSag = capture('x', false, true);
        const imgCor = capture('y', false, true);
        const imgAx = capture('z', false, true);

        //Titles & Colors
        const modTitle = task.modality === 'phase' ? 'Phase' : 'FLAIRSTAR';
        const contextStr = task.label ? `(${task.label})` : '';
        const titleClass = task.type === 'cvs' ? 'cvs' : 'prl';

        reportHTML += `
            <div class="lesion">
              <div class="lesion-header">
                <div>
                    <div class="lesion-title">${modTitle} Analysis <span style="font-size:16px; color:#94a3b8; font-weight:400;">Lesion ${lesionIdx + 1}</span></div>
                    <div class="lesion-meta">${contextStr}</div>
                </div>
                <div style="text-align: right;">
                    <div class="lesion-score">CVS Score: ${((lesionScores[lesionIdx] || 0) * 100).toFixed(0)}%</div>
                    <div class="lesion-meta" style="margin-top:8px;">Vol: ${l.volume} vox | PRL: ${isPrl ? 'Yes' : 'No'}</div>
                </div>
              </div>
              
              <!-- Row 1: Zoomed View -->
              <div class="row-title">Zoomed View (Slice Focus)</div>
              <div class="image-grid">
                <div class="grid-column">
                    <div class="axis-label">Sagittal</div>
                    <div class="img-card">
                        <img src="${imgSagZ}" />
                        <div class="img-meta">Slice ${savedCoords.x}</div>
                    </div>
                </div>
                <div class="grid-column">
                    <div class="axis-label">Coronal</div>
                    <div class="img-card">
                        <img src="${imgCorZ}" />
                        <div class="img-meta">Slice ${savedCoords.y}</div>
                    </div>
                </div>
                <div class="grid-column">
                    <div class="axis-label">Axial</div>
                    <div class="img-card">
                        <img src="${imgAxZ}" />
                        <div class="img-meta">Slice ${savedCoords.z}</div>
                    </div>
                </div>
              </div>

              <!-- Row 2: Full Context -->
              <div class="row-title">Full Context</div>
              <div class="image-grid">
                <div class="grid-column">
                    <div class="img-card">
                        <img src="${imgSag}" />
                    </div>
                </div>
                <div class="grid-column">
                    <div class="img-card">
                        <img src="${imgCor}" />
                    </div>
                </div>
                <div class="grid-column">
                    <div class="img-card">
                        <img src="${imgAx}" />
                    </div>
                </div>
              </div>
            </div>
          `;
      }
    }

    reportHTML += '</div></body></html>';

    // Open report
    const reportWindow = window.open('', '_blank');
    if (reportWindow) {
      reportWindow.document.write(reportHTML);
      reportWindow.document.close();
    } else {
      alert("Pop-up blocked! Please allow pop-ups.");
    }

    setLoading(false);
  };

  // Top row Zoom Factor
  const topZoom = zoom * 2;

  if (!volumes.flairStar && !loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center p-4">
        <Text className="text-white text-3xl font-bold mb-8">CvsView Web</Text>
        <TouchableOpacity
          onPress={() => setShowLoadModal(true)}
          className="bg-primary px-8 py-4 rounded-lg active:opacity-80 mb-4"
        >
          <Text className="text-white text-xl font-bold">Load Data</Text>
        </TouchableOpacity>



        <DataLoadModal
          visible={showLoadModal}
          onClose={() => setShowLoadModal(false)}
          onLoadData={handleDataLoad}
        />

      </View>
    );
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text className="text-white text-xl font-bold mt-4">
          {typeof loading === 'string' ? loading : "Processing MRI Data..."}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background flex-col h-screen">
      <View className="flex-1 flex-col">
        <StatusBar style="light" />

        {/* Title Bar */}
        <View className="w-full bg-surface p-4 border-b border-white/10 flex-row items-center justify-between">
          <Text className="text-white text-2xl font-bold">CvsView Web</Text>

          <View className="flex-row gap-2">
            <TouchableOpacity
              onPress={() => setShowLoadModal(true)}
              className="bg-primary px-4 py-2 rounded-lg active:opacity-80"
            >
              <Text className="text-white font-bold">Load Data</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={generateReport}
              className="bg-primary px-4 py-2 rounded-lg active:opacity-80"
            >
              <Text className="text-white font-bold">Generate Report</Text>
            </TouchableOpacity>
          </View>
        </View>

        <DataLoadModal
          visible={showLoadModal}
          onClose={() => setShowLoadModal(false)}
          onLoadData={handleDataLoad}
        />

        <View className="flex-1 flex-row">
          {/* Main Viewer Area (2x3 Grid) */}
          <View className="flex-1 flex-col p-2 gap-2">
            {/* Top Row: Zoomed Views */}
            <View className="flex-1 flex-row gap-2">
              <SliceViewer label="Sagittal (Zoom)" axis="x" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={topZoom} windowMin={currentMin} windowMax={currentMax} modality={modality} showMask={showMask} cursor="none" fovZoom={topZoom} currentLesionLabel={lesions[lesionIndex]?.id}
                onSliceChange={(val) => handleUpdateCoords(prev => ({ ...prev, x: val }))}
              />
              <SliceViewer label="Coronal (Zoom)" axis="y" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={topZoom} windowMin={currentMin} windowMax={currentMax} modality={modality} showMask={showMask} cursor="none" fovZoom={topZoom} currentLesionLabel={lesions[lesionIndex]?.id}
                onSliceChange={(val) => handleUpdateCoords(prev => ({ ...prev, y: val }))}
              />
              <SliceViewer label="Axial (Zoom)" axis="z" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={topZoom} windowMin={currentMin} windowMax={currentMax} modality={modality} showMask={showMask} cursor="none" fovZoom={topZoom} currentLesionLabel={lesions[lesionIndex]?.id}
                onSliceChange={(val) => handleUpdateCoords(prev => ({ ...prev, z: val }))}
              />
            </View>

            {/* Bottom Row: Full Views (Less Zoom) */}
            <View className="flex-1 flex-row gap-2">
              <View className="flex-1 flex-row gap-2">
                <SliceViewer label="Sagittal" axis="x" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={1} windowMin={currentMin} windowMax={currentMax} modality={modality} onClick={handleUpdateCoords} interactive showMask={showMask} cursor="box" boxZoom={topZoom} currentLesionLabel={lesions[lesionIndex]?.id} />
                <SliceViewer label="Coronal" axis="y" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={1} windowMin={currentMin} windowMax={currentMax} modality={modality} onClick={handleUpdateCoords} interactive showMask={showMask} cursor="box" boxZoom={topZoom} currentLesionLabel={lesions[lesionIndex]?.id} />
                <SliceViewer label="Axial" axis="z" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={1} windowMin={currentMin} windowMax={currentMax} modality={modality} onClick={handleUpdateCoords} interactive showMask={showMask} cursor="box" boxZoom={topZoom} currentLesionLabel={lesions[lesionIndex]?.id} />
              </View>
            </View>
          </View>

          {/* Sidebar Controls - Scrollable */}
          <View className="w-80 bg-surface border-l border-white/10 h-full">
            <ScrollView className="flex-1 p-4" contentContainerStyle={{ gap: 24, paddingBottom: 20 }}>

              <View>
                <Text className="text-white text-xl font-bold mb-4">Controls</Text>

                <Text className="text-text-muted mb-2">Lesion Navigation</Text>
                <View className="flex-row items-center justify-between mb-2 bg-black/20 p-2 rounded">
                  <View className="flex-row gap-1">
                    <TouchableOpacity onPress={() => jumpToLesion(0)} className="bg-white/10 h-10 w-10 rounded items-center justify-center"><Text className="text-white font-bold">{"<<"}</Text></TouchableOpacity>
                    <TouchableOpacity onPress={handlePrevLesion} className="bg-white/10 h-10 w-10 rounded items-center justify-center"><Text className="text-white font-bold">{"<"}</Text></TouchableOpacity>
                  </View>
                  <Text className="text-white font-mono text-lg">
                    {(lesions.length > 0) ? (lesionIndex + 1) + " / " + lesions.length : "0 / 0"}
                  </Text>
                  <View className="flex-row gap-1">
                    <TouchableOpacity onPress={handleNextLesion} className="bg-white/10 h-10 w-10 rounded items-center justify-center"><Text className="text-white font-bold">{">"}</Text></TouchableOpacity>
                    <TouchableOpacity onPress={() => jumpToLesion(lesions.length - 1)} className="bg-white/10 h-10 w-10 rounded items-center justify-center"><Text className="text-white font-bold">{">>"}</Text></TouchableOpacity>
                  </View>
                </View>

                <View className="flex-row gap-2 mb-4 bg-black/20 p-2 rounded">
                  <TouchableOpacity onPress={() => setZoom(z => Math.max(0.2, z - 0.5))} className="bg-white/10 h-10 w-10 rounded items-center justify-center active:bg-white/20"><Text className="text-white font-bold text-lg">-</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => setZoom(z => Math.min(10, z + 0.5))} className="bg-white/10 h-10 w-10 rounded items-center justify-center active:bg-white/20"><Text className="text-white font-bold text-lg">+</Text></TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      if (lesions[lesionIndex]) {
                        const l = lesions[lesionIndex];
                        handleUpdateCoords({ x: l.x, y: l.y, z: l.z });
                      }
                    }}
                    className="flex-1 bg-white/10 h-10 rounded items-center justify-center active:bg-white/20"
                  >
                    <Text className="text-white text-xs font-bold">Reset</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => setShowMask(!showMask)}
                    className={`flex-1 h-10 rounded items-center justify-center ${showMask ? 'bg-green-500/20 border border-green-500/50' : 'bg-white/10'}`}
                  >
                    <Text className={`text-xs font-bold ${showMask ? 'text-green-400' : 'text-white'}`}>
                      Mask
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text className="text-xs text-text-muted">Vol: {lesions[lesionIndex]?.volume} vox</Text>
              </View>

              <View>
                <Text className="text-text-muted mb-2">Modality</Text>
                <View className="gap-2">
                  {['flairStar', 'swi', 'flair', 'phase'].map((m, i) => (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setModality(m)}
                      className={`p-3 rounded border ${modality === m ? 'bg-primary border-primary' : 'bg-transparent border-white/20'}`}
                    >
                      <Text className="text-white font-bold uppercase">{i + 1}. {m}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View>
                <Text className="text-text-muted mb-2">Likelihood of Vein</Text>
                <Text className="text-white text-2xl font-bold mb-2 text-center">{(veinLikelihood * 100).toFixed(0)}%</Text>
                <View className="h-10 bg-white/5 rounded justify-center px-2">
                  <Slider
                    style={{ width: '100%', height: 40 }}
                    minimumValue={0}
                    maximumValue={1}
                    step={0.01}
                    value={veinLikelihood}
                    onValueChange={updateScore}
                    minimumTrackTintColor="#3b82f6"
                    maximumTrackTintColor="#FFFFFF"
                  />
                </View>

                {/* PRL Checkbox */}
                <TouchableOpacity
                  onPress={() => {
                    setLesionPRL(prev => ({ ...prev, [lesionIndex]: !prev[lesionIndex] }));
                  }}
                  className="flex-row items-center mt-3 p-2 bg-black/20 rounded"
                >
                  <View className={`w-5 h-5 border-2 rounded mr-2 items-center justify-center ${lesionPRL[lesionIndex] ? 'bg-primary border-primary' : 'border-white/40'}`}>
                    {lesionPRL[lesionIndex] && <Text className="text-white text-xs font-bold">✓</Text>}
                  </View>
                  <Text className="text-white text-sm">PRL+ (Paramagnetic Rim)</Text>
                </TouchableOpacity>
              </View>

              <View>
                <View>
                  <Text className="text-text-muted mb-2">Window Level (Min/Max)</Text>
                  <View className="items-center">
                    <MultiSlider
                      values={[currentMin, currentMax]}
                      onValuesChange={(vals) => {
                        setWindowMin(vals[0]);
                        setWindowMax(vals[1]);
                      }}
                      min={contrastLimits[modality]?.min ?? -5}
                      max={contrastLimits[modality]?.max ?? 10}
                      step={modality === 'phase' ? 1 : 0.1} // Coarser step for Phase
                      sliderLength={220}
                      selectedStyle={{ backgroundColor: '#3b82f6' }}
                      unselectedStyle={{ backgroundColor: '#ffffff20' }}
                      markerStyle={{ backgroundColor: '#ffffff', height: 20, width: 20 }}
                    />
                  </View>
                </View>
              </View>

              {/* Info Box */}
              <View className="bg-black/30 p-4 rounded border border-white/10">
                <Text className="text-white font-bold text-xl mb-2">Session Stats</Text>
                <View className="gap-1">
                  <Text className="text-white text-base">Total Lesions: <Text className="font-bold text-primary">{lesions.length}</Text></Text>
                  <Text className="text-white text-base">Total Volume: <Text className="font-bold text-primary">{totalVolume.toFixed(2)} ml</Text></Text>
                  <Text className="text-white text-base">Possible CVS+: <Text className="font-bold text-primary">{validLesionsCount}</Text></Text>
                  <Text className="text-white text-base">PRL+: <Text className="font-bold text-primary">{prlLesionsCount}</Text></Text>
                </View>
              </View>

            </ScrollView>
          </View>
        </View>
      </View>
    </View>
  );
}
