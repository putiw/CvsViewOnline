import { StatusBar } from 'expo-status-bar';
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { Asset } from 'expo-asset';
import { loadNifti } from './utils/niftiLoader';
import { findConnectedComponents } from './utils/lesionAnalysis';
import { zNormalize, calculateContrastPercentiles } from './utils/imageProcessing';
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
  const [dims, setDims] = useState([0, 0, 0]);
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

      // Normalize images (Z-score)
      const t0 = performance.now();
      const volFlairStar = zNormalize(vFlairStar.data);
      const volSwi = vSwi ? zNormalize(vSwi.data) : null;
      const volFlair = vFlair ? zNormalize(vFlair.data) : null;
      const volPhase = vPhase ? zNormalize(vPhase.data) : null;
      console.log(`Normalization took ${(performance.now() - t0).toFixed(0)}ms`);

      // Calculate percentiles for automatic contrast
      const t1 = performance.now();
      const flairStarPerc = calculateContrastPercentiles(volFlairStar);
      const swiPerc = volSwi ? calculateContrastPercentiles(volSwi) : { min: -1.5, max: 1.96 };
      const flairPerc = volFlair ? calculateContrastPercentiles(volFlair) : { min: -1.5, max: 1.96 };
      const phasePerc = volPhase ? calculateContrastPercentiles(volPhase) : { min: -1.5, max: 1.96 };
      console.log(`Percentile calculation took ${(performance.now() - t1).toFixed(0)}ms`);

      // Set contrast defaults
      setContrastSettings({
        flairStar: flairStarPerc,
        swi: swiPerc,
        flair: flairPerc,
        phase: phasePerc,
      });

      // Store volumes
      const newVolumes = {
        flairStar: volFlairStar,
        swi: volSwi,
        flair: volFlair,
        phase: volPhase,
        lesion: vLesion.data
      };

      setVolumes(newVolumes);
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

  const generateReport = async () => {
    const html2canvas = (await import('html2canvas')).default;

    // Get CVS+ lesions
    const cvsLesions = lesions.filter((_, idx) => lesionScores[idx] >= 0.5);


    // Create report HTML
    let reportHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>CvsView Report</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a1a; color: white; }
          h1 { color: #3b82f6; }
          .stats { background: #2a2a2a; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
          .lesion { margin-bottom: 30px; page-break-inside: avoid; }
          .lesion h3 { color: #3b82f6; }
          img { max-width: 100%; border: 1px solid #444; }
        </style>
      </head>
      <body>
        <h1>CvsView Session Report</h1>
        <div class="stats">
          <h2>Session Statistics</h2>
          <p>Total Lesions: ${lesions.length}</p>
          <p>Total Volume: ${totalVolume.toFixed(2)} ml</p>
          <p>CVS+ Lesions: ${validLesionsCount}</p>
          <p>PRL+ Lesions: ${prlLesionsCount}</p>
        </div>
        <h2>CVS+ Lesion Details</h2>
    `;

    // Capture screenshots for each CVS+ lesion
    const viewerArea = document.querySelector('.flex-1.flex-col.p-2');

    for (let i = 0; i < cvsLesions.length; i++) {
      const lesionIdx = lesions.indexOf(cvsLesions[i]);

      // Navigate to lesion
      setLesionIndex(lesionIdx);
      const l = lesions[lesionIdx];
      setCoords({ x: l.x, y: l.y, z: l.z });

      // Wait for render
      await new Promise(resolve => setTimeout(resolve, 500));

      // Temporarily hide mask
      const originalShowMask = showMask;
      setShowMask(false);
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture screenshot
      const canvas = await html2canvas(viewerArea, {
        scale: 1,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#1a1a1a',
        onclone: (clonedDoc) => {
          // Fix canvas transforms for screenshot
          // html2canvas ignores CSS scale transforms on canvas, so we manually bake it in
          const canvases = clonedDoc.querySelectorAll('canvas[data-scale-y]');
          canvases.forEach(c => {
            const ratio = parseFloat(c.getAttribute('data-scale-y'));
            if (ratio && ratio !== 1) {
              // Create replacement canvas of correct visual size (square)
              const tempC = clonedDoc.createElement('canvas');
              const w = c.width;
              // We want final visual height to equal width (square)
              // But strictly speaking we just want to apply the stretch.
              // Logic: visualHeight = rawHeight * ratio.
              const h = c.height * ratio;

              tempC.width = w;
              tempC.height = h;

              const ctx = tempC.getContext('2d');
              // Turn off smoothing for pixelated look
              ctx.imageSmoothingEnabled = false;

              // Scale and draw original content
              ctx.scale(1, ratio);
              ctx.drawImage(c, 0, 0);

              // Replace in DOM
              c.parentNode.replaceChild(tempC, c);
              tempC.style.width = '100%';
              tempC.style.height = '100%';
              tempC.style.objectFit = 'contain';
            }
          });
        }
      });
      const imgData = canvas.toDataURL('image/png');

      // Restore mask
      setShowMask(originalShowMask);

      reportHTML += `
        <div class="lesion">
          <h3>Lesion ${lesionIdx + 1}</h3>
          <p>Volume: ${l.volume} voxels</p>
          <p>CVS Likelihood: ${((lesionScores[lesionIdx] || 0) * 100).toFixed(0)}%</p>
          <p>PRL: ${lesionPRL[lesionIdx] ? 'Yes' : 'No'}</p>
          <img src="${imgData}" alt="Lesion ${lesionIdx + 1}" />
        </div>
      `;
    }

    reportHTML += '</body></html>';

    // Open report in new window
    const reportWindow = window.open('', '_blank');
    reportWindow.document.write(reportHTML);
    reportWindow.document.close();
  };

  // Stats Logic
  const validLesionsCount = Object.values(lesionScores).filter(s => s >= 0.5).length;
  const prlLesionsCount = Object.values(lesionPRL).filter(p => p).length;
  const totalVolume = lesions.reduce((acc, l) => acc + (l.volume * pixDims[0] * pixDims[1] * pixDims[2]), 0) / 1000;

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
                  min={-5}
                  max={10}
                  step={0.1}
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
