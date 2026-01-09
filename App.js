import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, Alert, StyleSheet } from 'react-native';
import { useFonts } from 'expo-font';
import * as DocumentPicker from 'expo-document-picker';
import MultiSlider from '@ptomasroos/react-native-multi-slider';
import './global.css';

// Web-specific imports
import { Platform } from 'react-native';
import html2canvas from 'html2canvas';

// Components
import SliceViewer from './components/SliceViewer';

// Utils
import { loadNiftiFile } from './utils/niftiLoader';
import { analyzeLesion } from './utils/lesionAnalysis';

// Asset Requires (for web/bundling)
const INITIAL_ASSETS = {
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

  const fontsLoaded = true; // System fonts

  // On Mount: Load Initial Data
  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    setLoading(true);
    try {
      // 1. Load Files
      const volSWI = await loadNiftiFile(INITIAL_ASSETS.swi);
      const volFLAIR = await loadNiftiFile(INITIAL_ASSETS.flair);
      const volPhase = await loadNiftiFile(INITIAL_ASSETS.phase);
      const volLesion = await loadNiftiFile(INITIAL_ASSETS.lesion);

      // Extract Dims from one (assuming coregistered)
      // NIfTI dims: [rank, dimX, dimY, dimZ, t, ...]
      // pixDims: [qfac, pixX, pixY, pixZ, ...]
      const dimensions = volSWI.header.dims.slice(1, 4);
      const voxelSizes = volSWI.header.pixDims.slice(1, 4);

      setDims(dimensions);
      setPixDims(voxelSizes);

      // 2. Compute FLAIRSTAR = FLAIR * SWI (normalized)
      // Simple approximation: ensure arrays match size
      const size = dimensions[0] * dimensions[1] * dimensions[2];
      const volFLAIRSTAR = new Float32Array(size);

      // Normalize helper
      const normalize = (data) => {
        // Robust scaling (percentiles)
        // For simplicity: mean/std z-score
        let sum = 0, sumSq = 0;
        for (let i = 0; i < size; i++) {
          sum += data[i];
          sumSq += data[i] * data[i];
        }
        const mean = sum / size;
        const std = Math.sqrt(sumSq / size - mean * mean);
        const out = new Float32Array(size);
        for (let i = 0; i < size; i++) {
          out[i] = (data[i] - mean) / (std || 1);
        }
        return out;
      };

      const nSWI = normalize(volSWI.image);
      const nFLAIR = normalize(volFLAIR.image);
      const nPhase = normalize(volPhase.image);

      for (let i = 0; i < size; i++) {
        volFLAIRSTAR[i] = nFLAIR[i] * nSWI[i]; // element-wise multiplication
      }

      setVolumes({
        swi: nSWI,
        flair: nFLAIR,
        phase: nPhase,
        flairStar: volFLAIRSTAR,
        lesion: volLesion.image // Mask 0 or 1
      });

      // 3. Find Lesions
      const foundLesions = analyzeLesion(volLesion.image, dimensions);
      setLesions(foundLesions);

      if (foundLesions.length > 0) {
        setLesionIndex(0);
        jumpToLesion(0, foundLesions);
      }

    } catch (e) {
      console.error("Failed to load initial data", e);
      Alert.alert("Error", "Failed to load sample data");
    } finally {
      setLoading(false);
    }
  };

  const jumpToLesion = (idx, list = lesions) => {
    if (!list || list.length === 0) return;
    const l = list[idx];
    setCoords({ x: l.x, y: l.y, z: l.z });
    setVeinLikelihood(lesionScores[idx] || 0);
  };

  const handleNextLesion = () => {
    if (lesions.length === 0) return;
    const next = (lesionIndex + 1) % lesions.length;
    setLesionIndex(next);
    jumpToLesion(next);
  };

  const handlePrevLesion = () => {
    if (lesions.length === 0) return;
    const prev = (lesionIndex - 1 + lesions.length) % lesions.length;
    setLesionIndex(prev);
    jumpToLesion(prev);
  };

  const updateScore = (val) => {
    setVeinLikelihood(val[0]);
    setLesionScores(prev => ({ ...prev, [lesionIndex]: val[0] }));
  };

  // --------------------------------------------------------------------------------
  // REPORT GENERATION
  // --------------------------------------------------------------------------------
  const viewerRef = useRef(null);

  const generateReport = async () => {
    if (Platform.OS === 'web') {
      const viewerArea = document.querySelector('.flex-1.flex-row'); // Select main grid
      if (!viewerArea) return;

      setLoading(true);

      // Calculate Stats
      const totalVolume = lesions.reduce((acc, l) => acc + l.volume, 0) * (pixDims[0] * pixDims[1] * pixDims[2]) / 1000; // ml
      const validLesionsCount = Object.values(lesionScores).filter(s => s >= 0.5).length;
      const prlLesionsCount = Object.values(lesionPRL).filter(b => b).length;

      let reportHTML = `
        <html>
        <head>
          <style>
            body { font-family: sans-serif; background: #121212; color: #fff; padding: 20px; }
            h1, h2 { color: #3b82f6; }
            .stat-box { background: #1e1e1e; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
            .lesion-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
            .lesion-card { background: #000; border: 1px solid #333; padding: 10px; break-inside: avoid; }
            img { width: 100%; height: auto; display: block; }
            .meta { font-size: 0.8em; color: #aaa; margin-bottom: 5px; }
          </style>
        </head>
        <body>
          <h1>CvsView Session Report</h1>
          
          <div class="stat-box">
            <h2>Session Statistics</h2>
            <p>Total Lesions: ${lesions.length}</p>
            <p>Total Volume: ${totalVolume.toFixed(2)} ml</p>
            <p>CVS+ Lesions: ${validLesionsCount}</p>
            <p>PRL+ Lesions: ${prlLesionsCount}</p>
          </div>

          <h2>CVS+ Lesion Details</h2>
          <div class="lesion-container">
      `;

      // Iterate through only Valid CVS+ Lesions
      // For demo, we just do the current viewing one + screenshots, 
      // but ideally we iterate and jump-render-capture. 
      // Since jump-render is async, we capture only current state for this prototype 
      // or implement a loop. Let's implement a loop for 'CVS Likelihood > 0'

      // Filter lesions that have score > 0 (or some threshold, e.g. 0.5)
      // If none, showing all for debug or just current? 
      // Let's loop ALL lesions for completeness in this verified logic.

      const originalIndex = lesionIndex;

      for (let i = 0; i < lesions.length; i++) {
        // Only include if marked as CVS+ (score >= 0.5)
        const score = lesionScores[i] || 0;
        if (score < 0.5) continue;

        const isPRL = lesionPRL[i] ? "Yes" : "No";

        // Jump to lesion
        setLesionIndex(i);
        const l = lesions[i];
        setCoords({ x: l.x, y: l.y, z: l.z });

        // Wait for render
        await new Promise(resolve => setTimeout(resolve, 500));

        // Temporarily hide mask
        const originalShowMask = showMask;
        setShowMask(false);
        await new Promise(resolve => setTimeout(resolve, 100));

        // Capture screenshot of the viewer area as-is
        // NOTE: we removed the onclone manual scaling because it was causing over-stretching.
        const canvas = await html2canvas(viewerArea, {
          scale: 1,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#1a1a1a',
        });
        const imgData = canvas.toDataURL('image/png');

        // Restore mask
        setShowMask(originalShowMask);

        reportHTML += `
          <div class="lesion">
            <h3>Lesion ${i + 1}</h3>
            <div class="meta">
              Volume: ${l.volume} voxels<br/>
              CVS Likelihood: ${(score * 100).toFixed(0)}%<br/>
              PRL: ${isPRL}
            </div>
            <img src="${imgData}" />
            <hr style="border-color: #333; margin: 20px 0;"/>
          </div>
        `;
      }

      // Restore state
      setLesionIndex(originalIndex);
      jumpToLesion(originalIndex);

      reportHTML += `
          </div>
        </body>
        </html>
      `;

      // Open in new window
      const win = window.open('', '_blank');
      win.document.write(reportHTML);
      win.document.close();

      setLoading(false);
    } else {
      Alert.alert("Notice", "PDF Generation is web-only for this demo.");
    }
  };

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-white text-xl">Loading Data...</Text>
      </View>
    );
  }

  // Derived Zoom for top row
  const topZoom = zoom * 1.5 < 1.0 ? 1.0 : zoom * 1.5;
  // Actually logic: If zoom=1, topZoom=1.0? 
  // Requirement: "zoomed views (top row)" usually implies magnification.
  // If user sets global zoom, we can scale this. 
  // Let's keep it simple: Top row is "Zoomed", Bottom row is "Context".
  // Range Slider controls "zoom" state which affects BOTH? 
  // Or usually: Bottom row is fixed FOV? 

  // CURRENT LOGIC:
  // Bottom Row: Full FOV (SliceViewer handles this if fovZoom undefined or handled internally?)
  // Actually SliceViewer prop 'zoom' controls pixel scaling.
  // Prop 'fovZoom' controls the "crop" effect.

  // Re-reading SliceViewer: 
  // If fovZoom set -> Crop mode.
  // If zoom set -> Canvas scale? No, SliceViewer uses zoom for calculation? 
  // SliceViewer prop 'zoom' seems unused inside useEffect? 
  // Ah, looking at SliceViewer code... 'zoom' prop is passed but NOT USED in calc?
  // Only 'fovZoom' is used for the crop. 

  // So 'zoom' state in App.js drives 'fovZoom' prop for top row.
  // Bottom row gets zoom={1}, no fovZoom? 
  // Check JSX below.

  return (
    <View className="flex-1 bg-background flex-row h-screen">

      {/* Sidebar / Header (Left or Top?) using simple layout */}
      <View className="flex-1 flex-col">
        {/* Header */}
        <View className="h-14 bg-surface border-b border-white/10 flex-row items-center px-4 justify-between">
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
            </View>

            <View>
              <Text className="text-text-muted mb-2">Modality</Text>
              <View className="flex-row flex-wrap gap-2">
                {['flairStar', 'flair', 'swi', 'phase'].map(m => (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setModality(m)}
                    className={`px-3 py-2 rounded ${modality === m ? 'bg-primary' : 'bg-white/10'}`}
                  >
                    <Text className="text-white uppercase text-xs font-bold">{m}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View>
              <Text className="text-text-muted mb-2">Zoom Level ({zoom.toFixed(1)}x)</Text>
              <View className="items-center">
                <MultiSlider
                  values={[zoom]}
                  onValuesChange={(val) => setZoom(val[0])}
                  min={1}
                  max={5}
                  step={0.1}
                  sliderLength={280}
                  selectedStyle={{ backgroundColor: '#3b82f6' }}
                  unselectedStyle={{ backgroundColor: '#ffffff20' }}
                  markerStyle={{ backgroundColor: '#ffffff', height: 20, width: 20 }}
                />
              </View>
            </View>

            <View>
              <Text className="text-text-muted mb-2">Likelihood of Vein</Text>
              <Text className="text-white text-2xl font-bold mb-2 text-center">{(veinLikelihood * 100).toFixed(0)}%</Text>
              <View className="h-10 bg-white/5 rounded justify-center px-2">
                <MultiSlider
                  values={[veinLikelihood]}
                  onValuesChange={(val) => updateScore(val)}
                  min={0}
                  max={1}
                  step={0.01}
                  sliderLength={280}
                  selectedStyle={{ backgroundColor: '#3b82f6' }}
                  unselectedStyle={{ backgroundColor: '#ffffff20' }}
                  markerStyle={{ backgroundColor: '#ffffff', height: 20, width: 20 }}
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
    </View>
  );
}
