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
  const [lesionScores, setLesionScores] = useState({});
  const [lesionPRL, setLesionPRL] = useState({}); // Map index -> isPRL

  // Coordinates (voxel space)
  const [coords, setCoords] = useState({ x: 0, y: 0, z: 0 });
  const [zoom, setZoom] = useState(1); // Set default zoom to 1

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
        case 'ArrowUp': setZoom(z => Math.min(10, z + 0.25)); break;
        case 'ArrowDown': setZoom(z => Math.max(0.5, z - 0.25)); break;
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
      const flairStarPerc = calculateContrastPercentiles(normFlairStar, 0.01, 0.999);
      const swiPerc = vSwi ? calculateContrastPercentiles(normSwi, 0.01, 0.999) : { min: -1.5, max: 1.96 };
      const flairPerc = vFlair ? calculateContrastPercentiles(normFlair, 0.01, 0.999) : { min: -1.5, max: 1.96 };
      // Phase: No percentiles needed? User said -500 to 500. 
      // But we can calculate just in case, or skip. Skip to save time.

      console.log(`Percentile calculation took ${(performance.now() - t1).toFixed(0)}ms`);

      console.log("Lesion Mask:", vLesion.dims);
      console.log("PixDims from Header:", vFlairStar.header.pixDims ? vFlairStar.header.pixDims.slice(1, 4) : 'N/A');

      setVolumes({
        flairStar: normFlairStar,
        phase: rawPhase, // Raw!
        swi: normSwi,
        flair: normFlair,
        lesion: vLesion.data
      });

      // Calculate Percentiles for Defaults and Slider Limits
      // Slider Limits: 0.01% to 99.99% (Full Range)
      const getLimits = (data) => calculateContrastPercentiles(data, 0.01, 99.99);

      const limFlairStar = getLimits(normFlairStar);
      const limSwi = vSwi ? getLimits(normSwi) : { min: -5, max: 10 };
      const limFlair = vFlair ? getLimits(normFlair) : { min: -5, max: 10 };
      const limPhase = vPhase ? getLimits(vPhase.data) : { min: -1000, max: 1000 };

      // Set Slider Limits
      setContrastLimits({
        flairStar: limFlairStar,
        swi: limSwi,
        flair: limFlair,
        phase: limPhase
      });

      // Calculate Defaults (1% to 99.9% usually, but Phase is fixed)
      const getDef = (data) => calculateContrastPercentiles(data, 1, 99.9);
      const defFlairStar = getDef(normFlairStar);
      const defSwi = vSwi ? getDef(normSwi) : { min: -1.5, max: 1.96 };
      const defFlair = vFlair ? getDef(normFlair) : { min: -1.5, max: 1.96 };
      // Phase Default: Fixed -500 to 500
      const defPhase = { min: -500, max: 500 };

      // Set contrast defaults
      setContrastSettings({
        flairStar: defFlairStar,
        swi: defSwi,
        flair: defFlair,
        phase: defPhase,
      });

      // Removed duplicate setVolumes call that was overwriting data with undefined/incorrect values

      setDims(vFlairStar.dims);
      setPixDims(vFlairStar.pixDims); // Save pixDims

      // Analyze Lesions
      console.log("Analyzing lesions...");
      const analysis = findConnectedComponents(vLesion.data, vFlairStar.dims);
      setLesions(analysis.lesions);

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

  const handleNextLesion = () => {
    if (lesions.length === 0) return;
    const nextIdx = (lesionIndex + 1) % lesions.length;
    setLesionIndex(nextIdx);
    const l = lesions[nextIdx];
    setCoords({ x: l.x, y: l.y, z: l.z });
    setVeinLikelihood(lesionScores[nextIdx] || 0);
  };

  const handlePrevLesion = () => {
    if (lesions.length === 0) return;
    const prevIdx = (lesionIndex - 1 + lesions.length) % lesions.length;
    setLesionIndex(prevIdx);
    const l = lesions[prevIdx];
    setCoords({ x: l.x, y: l.y, z: l.z });
    setVeinLikelihood(lesionScores[prevIdx] || 0);
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
      Alert.alert("Notice", "PDF Generation is web-only for this demo.");
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
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 20px; background: #121212; color: #e0e0e0; }
          h1 { color: #60a5fa; border-bottom: 2px solid #333; padding-bottom: 10px; }
          h2 { color: #93c5fd; margin-top: 30px; }
          .stats { background: #1e1e1e; padding: 20px; border-radius: 8px; border: 1px solid #333; }
          .lesion { margin-bottom: 40px; background: #000; padding: 20px; border-radius: 8px; border: 1px solid #333; page-break-inside: avoid; }
          .lesion-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 15px; }
          .lesion-title { font-size: 1.2em; font-weight: bold; color: #60a5fa; }
          .lesion-meta { color: #888; font-size: 0.9em; }
          /* Grid Layout for Images */
          .image-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px; }
          .image-col { display: flex; flex-direction: column; gap: 5px; }
          .image-label { text-align: center; font-size: 0.8em; color: #aaa; background: #222; padding: 5px; border-radius: 4px; }
          img { width: 100%; height: auto; border: 1px solid #444; display: block; }
        </style>
      </head>
      <body>
        <h1>CvsView Session Report</h1>
        <div class="stats">
          <h2>Session Statistics</h2>
          <p><strong>Total Lesions:</strong> ${lesions.length}</p>
          <p><strong>Total Volume:</strong> ${totalVolume.toFixed(2)} ml</p>
          <p><strong>CVS+ Lesions:</strong> ${validLesionsCount}</p>
          <p><strong>PRL+ Lesions:</strong> ${prlLesionsCount}</p>
        </div>
        <h2>CVS+ Lesion Details</h2>
    `;

    // Use Headless Renderer for robust "WYSIWYG" but independent of DOM
    const captureOffscreen = (l, axis, isZoomed, isFull) => {
      // Prepare props matching SliceViewer
      // Top Row (Zoomed): fovZoom = topZoom. boxZoom = null.
      // Bottom Row (Full): fovZoom = null. boxZoom = topZoom.

      return renderSliceToDataURL({
        volumes: volumes,
        modality: modality,
        axis: axis,
        sliceCoords: { x: l.x, y: l.y, z: l.z },
        dims: dims,
        pixDims: pixDims,
        fovZoom: isZoomed ? topZoom : null,
        boxZoom: isFull ? topZoom : null,
        showMask: showMask,
        windowMin: currentMin,
        windowMax: currentMax,
        ignoreAspectRatio: isFull // Force 1:1 for Full Views to avoid "Tall" distortion
      });
    };

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

      // Determine Modality & Contrast
      let targetModality = 'flairStar';
      let tMin = 0;
      let tMax = 1000;

      if (isPrl && !isCvs) {
        // Pure PRL -> Phase
        targetModality = 'phase';
        tMin = -500; tMax = 500;
      } else if (isPrl && isCvs) {
        // Both -> Prioritize Phase for PRL visibility? Or FlairStar? 
        // User said "for PRL+... show screenshot... for CVS+ show flairstar"
        // Let's use Phase to highlight the PRL finding.
        targetModality = 'phase';
        tMin = -500; tMax = 500;
      } else {
        // CVS only -> FlairStar
        targetModality = 'flairStar';
        // Calculate 1-99.99% for THIS volume? Or use global defaults?
        // Using global defaults (calculated from FlairStar) is safe.
        // Or recalculate dynamic?
        // "make sure all images's default contrast range was set to 1 to 99.99 percentile"
        // Since we have raw data, we can just use the global calculated contrast for FlairStar
        // But wait, currentMin/Max in state are holding the FlairStar percentiles.
        tMin = currentMin; // Already 1-99.99% of FlairStar
        tMax = currentMax;
      }

      // Render 6 images using the selected settings
      const capture = (axis, isZoomed, isFull) => {
        return renderSliceToDataURL({
          volumes: volumes,
          modality: targetModality,
          axis: axis,
          sliceCoords: { x: l.x, y: l.y, z: l.z },
          dims: dims,
          pixDims: pixDims,
          fovZoom: isZoomed ? topZoom : null,
          boxZoom: isFull ? topZoom : null,
          showMask: showMask,
          windowMin: tMin,
          windowMax: tMax
          // Removed ignoreAspectRatio (User wants physical truth)
        });
      };

      const imgSagZ = capture('x', true, false);
      const imgCorZ = capture('y', true, false);
      const imgAxZ = capture('z', true, false);

      const imgSag = capture('x', false, true);
      const imgCor = capture('y', false, true);
      const imgAx = capture('z', false, true);

      reportHTML += `
          <div class="lesion">
            <div class="lesion-header">
              <div class="lesion-title">Lesion ${lesionIdx + 1} (${targetModality === 'phase' ? 'Phase' : 'FLAIRSTAR'})</div>
              <div class="lesion-meta">
                  Vol: ${l.volume} vox | CVS: ${((lesionScores[lesionIdx] || 0) * 100).toFixed(0)}% | PRL: ${isPrl ? 'Yes' : 'No'}
              </div>
            </div>
            
            <!-- Zoomed Row -->
            <div class="image-grid">
               <div class="image-col">
                 <div class="image-label">Sagittal (Zoom)</div>
                 <img src="${imgSagZ}" />
               </div>
               <div class="image-col">
                 <div class="image-label">Coronal (Zoom)</div>
                 <img src="${imgCorZ}" />
               </div>
               <div class="image-col">
                 <div class="image-label">Axial (Zoom)</div>
                 <img src="${imgAxZ}" />
               </div>
            </div>
            
            <!-- Full Row -->
            <div class="image-grid">
               <div class="image-col">
                 <div class="image-label">Sagittal (Full)</div>
                 <img src="${imgSag}" />
               </div>
               <div class="image-col">
                 <div class="image-label">Coronal (Full)</div>
                 <img src="${imgCor}" />
               </div>
               <div class="image-col">
                 <div class="image-label">Axial (Full)</div>
                 <img src="${imgAx}" />
               </div>
            </div>
            
          </div>
        `;
    }

    reportHTML += '</body></html>';

    // Open report
    const reportWindow = window.open('', '_blank');
    reportWindow.document.write(reportHTML);
    reportWindow.document.close();

    setLoading(false);
  };

  // Top row Zoom Factor
  const topZoom = zoom * 2;

  if (!volumes.flairStar && !loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center p-4">
        <Text className="text-white text-3xl font-bold mb-8">CvsView Web</Text>
        <TouchableOpacity
          onPress={loadData}
          className="bg-primary px-8 py-4 rounded-lg active:opacity-80"
        >
          <Text className="text-white text-xl font-bold">Load Sample BIDS</Text>
        </TouchableOpacity>
        <Text className="text-text-muted mt-4">Loads sub-dimah data</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text className="text-white mt-4">Processing MRI Data...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background flex-col h-screen">
      <StatusBar style="light" />

      {/* Title Bar */}
      <View className="w-full bg-surface p-4 border-b border-white/10 flex-row items-center justify-between">
        <Text className="text-white text-2xl font-bold">CvsView Web</Text>
        <TouchableOpacity
          onPress={generateReport}
          className="bg-primary px-4 py-2 rounded-lg active:opacity-80"
        >
          <Text className="text-white font-bold">Generate Report</Text>
        </TouchableOpacity>
      </View>

      <View className="flex-1 flex-row">
        {/* Main Viewer Area (2x3 Grid) */}
        <View className="flex-1 flex-col p-2 gap-2">
          {/* Top Row: Zoomed Views */}
          <View className="flex-1 flex-row gap-2">
            <SliceViewer label="Sagittal (Zoom)" axis="x" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={topZoom} windowMin={currentMin} windowMax={currentMax} modality={modality} showMask={showMask} cursor="none" fovZoom={topZoom} />
            <SliceViewer label="Coronal (Zoom)" axis="y" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={topZoom} windowMin={currentMin} windowMax={currentMax} modality={modality} showMask={showMask} cursor="none" fovZoom={topZoom} />
            <SliceViewer label="Axial (Zoom)" axis="z" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={topZoom} windowMin={currentMin} windowMax={currentMax} modality={modality} showMask={showMask} cursor="none" fovZoom={topZoom} />
          </View>

          {/* Bottom Row: Full Views (Less Zoom) */}
          <View className="flex-1 flex-row gap-2">
            <View className="flex-1 flex-row gap-2">
              <SliceViewer label="Sagittal" axis="x" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={1} windowMin={currentMin} windowMax={currentMax} modality={modality} onClick={setCoords} interactive showMask={showMask} cursor="box" boxZoom={topZoom} />
              <SliceViewer label="Coronal" axis="y" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={1} windowMin={currentMin} windowMax={currentMax} modality={modality} onClick={setCoords} interactive showMask={showMask} cursor="box" boxZoom={topZoom} />
              <SliceViewer label="Axial" axis="z" volumes={volumes} dims={dims} pixDims={pixDims} coords={coords} zoom={1} windowMin={currentMin} windowMax={currentMax} modality={modality} onClick={setCoords} interactive showMask={showMask} cursor="box" boxZoom={topZoom} />
            </View>
          </View>
        </View>

        {/* Sidebar Controls */}
        <View className="w-80 bg-surface p-4 border-l border-white/10 flex flex-col gap-6">

          <View>
            <Text className="text-white text-xl font-bold mb-4">Controls</Text>

            <Text className="text-text-muted mb-2">Lesion Navigation</Text>
            <View className="flex-row items-center justify-between mb-4 bg-black/20 p-2 rounded">
              <TouchableOpacity onPress={handlePrevLesion} className="bg-white/10 p-2 rounded w-10 items-center"><Text className="text-white font-bold">{"<"}</Text></TouchableOpacity>
              <Text className="text-white font-mono text-lg">
                {lesions.length > 0 ? `${lesionIndex + 1} / ${lesions.length}` : "0 / 0"}
              </Text>
              <TouchableOpacity onPress={handleNextLesion} className="bg-white/10 p-2 rounded w-10 items-center"><Text className="text-white font-bold">{">"}</Text></TouchableOpacity>
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
