import { StatusBar } from 'expo-status-bar';
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
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
const SAMPLE_FILES = {
  flairStar: require('./assets/sample_data/sub-dimah_ses-01_space-swi_FLAIRSTAR.nii.gz'),
  swi: require('./assets/sample_data/sub-dimah_ses-01_swi.nii.gz'),
  flair: require('./assets/sample_data/sub-dimah_ses-01_space-swi_FLAIR.nii.gz'),
  phase: require('./assets/sample_data/sub-dimah_ses-01_part-phase_swi.nii.gz'),
  lesion: require('./assets/sample_data/sub-dimah_ses-01_space-swi_desc-lesion_mask.nii.gz'),
};

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
    setLoading(true);
    try {
      const load = async (source) => {
        const asset = Asset.fromModule(source);
        await asset.downloadAsync();
        const response = await fetch(asset.uri);
        const buffer = await response.arrayBuffer();
        return loadNifti(buffer);
      };

      // Load all in parallel
      const [vFlairStar, vSwi, vFlair, vPhase, vLesion] = await Promise.all([
        load(SAMPLE_FILES.flairStar),
        load(SAMPLE_FILES.swi),
        load(SAMPLE_FILES.flair),
        load(SAMPLE_FILES.phase),
        load(SAMPLE_FILES.lesion),
      ]);

      if (!vFlairStar || !vLesion) throw new Error("Failed to load core files");

      // Parse header dimensions (NIfTI dims start at index 1)
      if (vFlairStar.header) {
        setDims(vFlairStar.header.dims.slice(1, 4));
        setPixDims(vFlairStar.header.pixDims.slice(1, 4));
      }

      // 3. Process Volumes
      // Z-Normalize everything EXCEPT Phase (User request)
      const t0 = performance.now();
      const normFlairStar = zNormalize(vFlairStar.data);
      const normSwi = vSwi ? zNormalize(vSwi.data) : null;
      const normFlair = vFlair ? zNormalize(vFlair.data) : null;
      // Phase kept raw for specific fixed-range viewing (-500 to 500)
      const rawPhase = vPhase ? vPhase.data : null;
      console.log(`Normalization took ${(performance.now() - t0).toFixed(0)}ms`);

      // Calculate percentiles
      // FlairStar etc: 1% to 99.9% of NORMALIZED data
      const t1 = performance.now();
      // Calculate Default Contrast Ranges (Visual Defaults)
      // Tighter range (2% - 99.5%) to avoid outliers making the image look gray/flat
      const flairStarPerc = calculateContrastPercentiles(normFlairStar, 2.0, 99.5);
      const swiPerc = vSwi ? calculateContrastPercentiles(normSwi, 2.0, 99.5) : { min: -1.5, max: 1.96 };
      const flairPerc = vFlair ? calculateContrastPercentiles(normFlair, 2.0, 99.5) : { min: -1.5, max: 1.96 };
      // Phase: No percentiles needed? User said -500 to 500. 
      // But we can calculate just in case, or skip. Skip to save time.

      console.log(`Percentile calculation took ${(performance.now() - t1).toFixed(0)}ms`);

      console.log("Lesion Mask:", vLesion.dims);
      console.log("PixDims from Header:", vFlairStar.header.pixDims ? vFlairStar.header.pixDims.slice(1, 4) : 'N/A');

      // Analyze Lesions FIRST to get labeled mask
      console.log("Analyzing lesions...");
      const analysis = findConnectedComponents(vLesion.data, vFlairStar.dims);
      setLesions(analysis.lesions);

      setVolumes({
        flairStar: normFlairStar,
        phase: rawPhase, // Raw!
        swi: normSwi,
        flair: normFlair,
        lesion: analysis.labeledMask // Use the LABELED mask!
      });

      // Restore Contrast Settings
      // 1. Slider Limits (Wide range: 0.01% - 99.99%)
      const getLimits = (data) => calculateContrastPercentiles(data, 0.01, 99.99);
      const limFlairStar = getLimits(normFlairStar);
      const limSwi = vSwi ? getLimits(normSwi) : { min: -5, max: 10 };
      const limFlair = vFlair ? getLimits(normFlair) : { min: -5, max: 10 };
      const limPhase = vPhase ? getLimits(vPhase.data) : { min: -1000, max: 1000 };

      setContrastLimits({
        flairStar: limFlairStar,
        swi: limSwi,
        flair: limFlair,
        phase: limPhase
      });

      // 2. Default View Settings (Optimized range: 2.0% - 99.5% calculated above)
      setContrastSettings({
        flairStar: flairStarPerc,
        swi: swiPerc,
        flair: flairPerc,
        phase: { min: -500, max: 500 }
      });

      // Set initial state
      if (analysis.lesions.length > 0) {
        const first = analysis.lesions[0];
        setCoords({ x: first.x, y: first.y, z: first.z });
      } else {
        setCoords({
          x: Math.floor(vFlairStar.dims[0] / 2),
          y: Math.floor(vFlairStar.dims[1] / 2),
          z: Math.floor(vFlairStar.dims[2] / 2)
        });
      }

    } catch (e) {
      console.error(e);
      alert("Error loading BIDS data: " + e.message);
    } finally {
      setLoading(false);
    }
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
  const handleDataLoad = async (buffers, _ignored) => {
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

    // Create report HTML
    let reportHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>CvsView Report</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 40px; background: #121212; color: #e0e0e0; font-size: 18px; zoom: 0.75; }
          
          @media print {
            .no-print { display: none !important; }
            body { background: #fff; color: #000; zoom: 1; }
          }
          
          h1 { color: #60a5fa; border-bottom: 2px solid #333; padding-bottom: 20px; font-size: 32px; margin-bottom: 40px; }
          h2 { color: #93c5fd; margin-top: 50px; font-size: 26px; border-bottom: 1px solid #333; padding-bottom: 10px; }
          
          .stats { background: #1e1e1e; padding: 30px; border-radius: 12px; border: 1px solid #333; font-size: 24px; margin-bottom: 40px; }
          .stats p { margin: 15px 0; line-height: 1.4; }
          .stats h2 { margin-top: 0; font-size: 32px; border-bottom: 1px solid #444; padding-bottom: 15px; margin-bottom: 20px; color: #fff; }

          .axis-container { display: flex; justify-content: center; gap: 15px; margin-bottom: 40px; }
          .axis-column { display: flex; flex-direction: column; gap: 20px; align-items: center; flex: 1; max-width: 400px; }
          .axis-title { font-size: 22px; color: #93c5fd; font-weight: bold; margin-bottom: 10px; text-align: center; }
          
          .img-wrapper { width: 100%; display: flex; flex-direction: column; align-items: center; background: #000; border: 1px solid #333; padding: 10px; border-radius: 8px; }
          .img-label { color: #aaa; margin-bottom: 8px; font-size: 16px; font-family: monospace; }
          
          img { display: block; max-width: 100%; object-fit: contain; background: #000; }
          .zoom-img { height: 250px; width: 250px; }
          .full-img { height: 500px; width: auto; }
          
          .lesion { margin-bottom: 60px; background: #000; padding: 30px; border-radius: 16px; border: 1px solid #333; page-break-inside: avoid; }
          .lesion-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 20px; margin-bottom: 25px; }
          .lesion-title { font-size: 1.6em; font-weight: bold; color: #60a5fa; }
          .lesion-title.cvs { color: #4ade80; }
          .lesion-title.prl { color: #60a5fa; }
          .lesion-meta { color: #aaa; font-size: 1.2em; }

        </style>
      </head>
      <body>
        <h1>CvsView Session Report</h1>
        <div class="stats">
          <h2>Session Statistics</h2>
          <p><strong>Total Lesions:</strong> <span style="color: #60a5fa">${lesions.length}</span></p>
          <p><strong>Total Volume:</strong> <span style="color: #60a5fa">${totalVolume.toFixed(2)} ml</span></p>
          <p><strong>CVS+ Lesions:</strong> <span style="color: #60a5fa">${validLesionsCount}</span></p>
          <p><strong>PRL+ Lesions:</strong> <span style="color: #60a5fa">${prlLesionsCount}</span></p>
        </div>
        <h2>Lesion Details</h2>
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
                <div class="lesion-title ${titleClass}">Lesion ${lesionIdx + 1}: ${modTitle} ${contextStr}</div>
                <div class="lesion-meta">
                    Vol: ${l.volume} vox | CVS Score: ${((lesionScores[lesionIdx] || 0) * 100).toFixed(0)}% | PRL: ${isPrl ? 'Yes' : 'No'}
                </div>
              </div>
              
              <div class="axis-container">
                <!-- Sagittal Column -->
                <div class="axis-column">
                  <div class="axis-title">Sagittal</div>
                  <div class="img-wrapper">
                    <div class="img-label">Zoom (Slice ${savedCoords.x})</div>
                    <img class="zoom-img" src="${imgSagZ}" />
                  </div>
                  <div class="img-wrapper">
                    <div class="img-label">Full (Slice ${savedCoords.x})</div>
                    <img class="full-img" src="${imgSag}" />
                  </div>
                </div>

                <!-- Coronal Column -->
                <div class="axis-column">
                  <div class="axis-title">Coronal</div>
                  <div class="img-wrapper">
                    <div class="img-label">Zoom (Slice ${savedCoords.y})</div>
                    <img class="zoom-img" src="${imgCorZ}" />
                  </div>
                  <div class="img-wrapper">
                    <div class="img-label">Full (Slice ${savedCoords.y})</div>
                    <img class="full-img" src="${imgCor}" />
                  </div>
                </div>

                <!-- Axial Column -->
                <div class="axis-column">
                  <div class="axis-title">Axial</div>
                  <div class="img-wrapper">
                    <div class="img-label">Zoom (Slice ${savedCoords.z})</div>
                    <img class="zoom-img" src="${imgAxZ}" />
                  </div>
                  <div class="img-wrapper">
                    <div class="img-label">Full (Slice ${savedCoords.z})</div>
                    <img class="full-img" src="${imgAx}" />
                  </div>
                </div>
              </div>
              
            </div>
          `;
      }
    }

    reportHTML += '</body></html>';

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

        <TouchableOpacity
          onPress={loadData}
          className="bg-white/10 px-6 py-3 rounded-lg active:bg-white/20"
        >
          <Text className="text-white font-bold">Load Sample BIDS (Demo)</Text>
        </TouchableOpacity>

        <DataLoadModal
          visible={showLoadModal}
          onClose={() => setShowLoadModal(false)}
          onLoadData={handleDataLoad}
        />
        <Text className="text-text-muted mt-4">Loads sub-dimah data</Text>
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

        {/* Sidebar Controls */}
        <View className="w-80 bg-surface p-4 border-l border-white/10 flex flex-col gap-6">

          <View>
            <Text className="text-white text-xl font-bold mb-4">Controls</Text>

            <Text className="text-text-muted mb-2">Lesion Navigation</Text>
            <View className="flex-row items-center justify-between mb-2 bg-black/20 p-2 rounded">
              <View className="flex-row gap-1">
                <TouchableOpacity onPress={() => jumpToLesion(0)} className="bg-white/10 p-2 rounded w-10 items-center"><Text className="text-white font-bold">{"<<"}</Text></TouchableOpacity>
                <TouchableOpacity onPress={handlePrevLesion} className="bg-white/10 p-2 rounded w-10 items-center"><Text className="text-white font-bold">{"<"}</Text></TouchableOpacity>
              </View>
              <Text className="text-white font-mono text-lg">
                {(lesions.length > 0) ? (lesionIndex + 1) + " / " + lesions.length : "0 / 0"}
              </Text>
              <View className="flex-row gap-1">
                <TouchableOpacity onPress={handleNextLesion} className="bg-white/10 p-2 rounded w-10 items-center"><Text className="text-white font-bold">{">"}</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => jumpToLesion(lesions.length - 1)} className="bg-white/10 p-2 rounded w-10 items-center"><Text className="text-white font-bold">{">>"}</Text></TouchableOpacity>
              </View>
            </View>

            <View className="flex-row gap-2 mb-4">
              <TouchableOpacity onPress={() => setZoom(z => Math.max(0.2, z - 0.5))} className="bg-white/10 p-2 rounded w-10 items-center justify-center active:bg-white/20"><Text className="text-white font-bold text-lg">-</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setZoom(z => Math.min(10, z + 0.5))} className="bg-white/10 p-2 rounded w-10 items-center justify-center active:bg-white/20"><Text className="text-white font-bold text-lg">+</Text></TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  if (lesions[lesionIndex]) {
                    const l = lesions[lesionIndex];
                    handleUpdateCoords({ x: l.x, y: l.y, z: l.z });
                  }
                }}
                className="flex-1 bg-white/10 p-2 rounded items-center active:bg-white/20"
              >
                <Text className="text-white text-xs font-bold">Reset</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setShowMask(!showMask)}
                className={`flex-1 p-2 rounded items-center ${showMask ? 'bg-green-500/20 border border-green-500/50' : 'bg-white/10'}`}
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
                  sliderLength={280}
                  selectedStyle={{ backgroundColor: '#3b82f6' }}
                  unselectedStyle={{ backgroundColor: '#ffffff20' }}
                  markerStyle={{ backgroundColor: '#ffffff', height: 20, width: 20 }}
                />
              </View>
            </View>
          </View>

          {/* Info Box */}
          <View className="bg-black/30 p-4 rounded border border-white/10 mt-auto">
            <Text className="text-white font-bold text-xl mb-2">Session Stats</Text>
            <View className="gap-1">
              <Text className="text-white text-base">Total Lesions: <Text className="font-bold text-primary">{lesions.length}</Text></Text>
              <Text className="text-white text-base">Total Volume: <Text className="font-bold text-primary">{totalVolume.toFixed(2)} ml</Text></Text>
              <Text className="text-white text-base">Possible CVS+: <Text className="font-bold text-primary">{validLesionsCount}</Text></Text>
              <Text className="text-white text-base">PRL+: <Text className="font-bold text-primary">{prlLesionsCount}</Text></Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
