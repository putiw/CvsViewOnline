import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Platform, Image, Modal } from 'react-native';
// Note: We use standard HTML input elements for file picking in web
// This component should be conditionally rendered only on Web or handling Platform.OS check internally

export default function DataLoadModal({ visible, onClose, onLoadData }) {
    if (!visible) return null;

    // Selected files for loading
    const [files, setFiles] = useState({
        flairStar: null,
        lesion: null,
        swi: null,
        flair: null,
        phase: null
    });

    // Multi-subject state
    const [scannedSubjects, setScannedSubjects] = useState({}); // { subId: { files... } }
    const [selectedSubjectId, setSelectedSubjectId] = useState(null);
    const [viewMode, setViewMode] = useState('initial'); // 'initial', 'subjectList', 'manual'

    const [loadingMsg, setLoadingMsg] = useState("");
    const [progress, setProgress] = useState(0);
    const [showHelp, setShowHelp] = useState(false);

    // For manual file inputs
    const fileInputRefs = {
        flairStar: useRef(null),
        lesion: useRef(null),
        swi: useRef(null),
        flair: useRef(null),
        phase: useRef(null),
    };

    // For BIDS directory input
    const directoryInputRef = useRef(null);

    const handleFileChange = (type, event) => {
        const file = event.target.files[0];
        if (file) {
            setFiles(prev => ({ ...prev, [type]: file }));
        }
    };

    const handleDirectoryScan = (event) => {
        const fileList = event.target.files;
        if (!fileList || fileList.length === 0) return;

        setLoadingMsg("Scanning folder...");

        const subjects = {}; // Map: sub-01 -> { files: {}, count: 0 }

        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            const name = file.name;
            const path = file.webkitRelativePath || "";

            // Extract Subject ID: looks for "sub-XXXX" in path
            // Pattern: match "sub-[alphanumeric]"
            const match = path.match(/(sub-[a-zA-Z0-9]+)/);
            if (!match) continue; // Skip files not in a subject folder

            const subId = match[1];

            if (!subjects[subId]) {
                subjects[subId] = {
                    flairStar: null,
                    lesion: null,
                    swi: null,
                    flair: null,
                    phase: null,
                    id: subId
                };
            }

            const found = subjects[subId];

            // 1. FLAIRSTAR
            if (!found.flairStar && name.includes('FLAIRSTAR') && name.endsWith('.nii.gz')) {
                found.flairStar = file;
            }
            // 2. Lesion Mask
            else if (!found.lesion && name.includes('lesion_mask') && name.endsWith('.nii.gz')) {
                found.lesion = file;
            }
            // 3. SWI
            else if (!found.swi && name.includes('_swi.nii.gz') && !name.includes('phase') && !name.includes('mag')) {
                found.swi = file;
            }
            // 4. Phase
            else if (!found.phase && (name.includes('phase') || name.includes('part-phase')) && name.endsWith('.nii.gz')) {
                found.phase = file;
            }
            // 5. FLAIR (space-swi)
            else if (!found.flair && name.includes('FLAIR') && !name.includes('FLAIRSTAR') && name.includes('space-swi') && name.endsWith('.nii.gz')) {
                found.flair = file;
            }
        }

        const subjectKeys = Object.keys(subjects).sort();
        setScannedSubjects(subjects);
        setLoadingMsg(`Scanned. Found ${subjectKeys.length} subjects.`);

        if (subjectKeys.length > 0) {
            setViewMode('subjectList');
        } else {
            alert("No BIDS subjects found in this folder. Make sure you selected the ROOT folder containing 'rawdata' and 'derivatives'.");
            setLoadingMsg("");
        }
    };

    const selectSubject = (subId) => {
        const subFiles = scannedSubjects[subId];
        setFiles(subFiles);
        setSelectedSubjectId(subId);
        setViewMode('manual'); // Go to file confirmation/loading view (reusing manual view)
        setLoadingMsg(`Selected ${subId}`);
    };

    const handleLoadClick = async () => {
        // Stats
        let totalBytes = 0;
        let loadedBytes = 0;
        const startTime = performance.now();
        setProgress(0);

        // Files to load
        const filesToLoad = [];
        if (files.flairStar) filesToLoad.push(files.flairStar);
        if (files.lesion) filesToLoad.push(files.lesion);
        if (files.swi) filesToLoad.push(files.swi);
        if (files.flair) filesToLoad.push(files.flair);
        if (files.phase) filesToLoad.push(files.phase);

        totalBytes = filesToLoad.reduce((acc, f) => acc + f.size, 0);

        setLoadingMsg(`Starting load... (0/${filesToLoad.length})`);

        // Helper to read file as ArrayBuffer with progress update
        // Helper to read file as ArrayBuffer with progress update
        const readFile = (file) => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();

                reader.onprogress = (event) => {
                    if (event.lengthComputable) {
                        const currentTotal = loadedBytes + event.loaded;
                        const elapsed = (performance.now() - startTime) / 1000;
                        const speed = elapsed > 0 ? (currentTotal / 1024 / 1024) / elapsed : 0;
                        const percent = Math.min(100, Math.round((currentTotal / totalBytes) * 100));
                        const remainingBytes = totalBytes - currentTotal;
                        const eta = speed > 0 ? (remainingBytes / 1024 / 1024) / speed : 0;

                        setProgress(percent);
                        setLoadingMsg(`Loading ${file.name}...\n${percent}% (${speed.toFixed(1)} MB/s) - ETA: ${eta.toFixed(0)}s`);
                    }
                };

                reader.onload = () => {
                    loadedBytes += file.size;
                    resolve(reader.result);
                };
                reader.onerror = reject;
                reader.readAsArrayBuffer(file);
            });
        };

        try {
            const buffers = {};

            // Required: FLAIRSTAR and LESION
            if (!files.flairStar || !files.lesion) {
                alert("FLAIRSTAR and Lesion Mask are required!");
                setLoadingMsg("");
                return;
            }

            // Load sequentially to track progress accurately (Parallel makes progress jumpy)
            if (files.flairStar) buffers.flairStar = await readFile(files.flairStar);
            if (files.lesion) buffers.lesion = await readFile(files.lesion);
            if (files.swi) buffers.swi = await readFile(files.swi);
            if (files.flair) buffers.flair = await readFile(files.flair);
            if (files.phase) buffers.phase = await readFile(files.phase);

            setLoadingMsg("Processing volume data...");
            setProgress(100);
            await new Promise(resolve => setTimeout(resolve, 100)); // Allow UI paint

            // Pass buffers back to App with status callback
            await onLoadData(buffers, (msg) => {
                setLoadingMsg(msg);
                // Also force repaint via delay if needed, but App.js handles delays
            });
            onClose(); // Close modal on success

        } catch (e) {
            console.error(e);
            alert("Error reading files: " + e.message);
            setLoadingMsg("Error.");
        }
    };

    const renderStatus = (file, label) => (
        <View className="flex-row items-center justify-between bg-white/5 p-2 rounded mb-2 border border-white/10">
            <View className="flex-1">
                <Text className="text-white font-bold">{label}</Text>
                <Text className="text-xs text-gray-400" numberOfLines={1}>
                    {file ? file.name : "Not selected"}
                </Text>
            </View>
            <TouchableOpacity
                onPress={() => fileInputRefs[labelToKey(label)].current.click()}
                className={`ml-2 px-3 py-1 rounded ${file ? 'bg-green-500/20 border border-green-500' : 'bg-blue-500/20 border border-blue-500'}`}
            >
                <Text className={file ? 'text-green-400' : 'text-blue-400'}>{file ? 'Change' : 'Select'}</Text>
            </TouchableOpacity>
        </View>
    );

    const labelToKey = (label) => {
        if (label.includes('FLAIRSTAR')) return 'flairStar';
        if (label.includes('Lesion')) return 'lesion';
        if (label.includes('SWI')) return 'swi';
        if (label === 'FLAIR') return 'flair';
        if (label.includes('Phase')) return 'phase';
        return 'flairStar';
    };

    const renderSubjectList = () => {
        const sortedIds = Object.keys(scannedSubjects).sort();
        return (
            <View>
                <View className="flex-row items-center mb-4">
                    <TouchableOpacity onPress={() => setViewMode('initial')} className="mr-2">
                        <Text className="text-blue-400">Back</Text>
                    </TouchableOpacity>
                    <Text className="text-white font-bold ml-2">Found Subjects ({sortedIds.length})</Text>
                </View>

                {sortedIds.map(subId => {
                    const s = scannedSubjects[subId];
                    const isReady = s.flairStar && s.lesion;
                    return (
                        <TouchableOpacity
                            key={subId}
                            onPress={() => selectSubject(subId)}
                            className={`flex-row justify-between items-center p-3 mb-2 rounded border ${isReady ? 'bg-green-500/10 border-green-500/30 active:bg-green-500/20' : 'bg-red-500/10 border-red-500/30 opacity-80'}`}
                        >
                            <View>
                                <Text className="text-white font-bold text-lg">{subId}</Text>
                                <Text className="text-gray-400 text-xs">
                                    {isReady ? '✅ Ready to Load' : '⚠️ Missing files (Check if visible)'}
                                </Text>
                            </View>
                            <Text className="text-gray-400 text-lg">›</Text>
                        </TouchableOpacity>
                    );
                })}
            </View>
        );
    };

    return (
        <View className="absolute inset-0 z-50 flex items-center justify-center bg-black/80">
            <View className="bg-[#1e1e1e] w-[600px] max-h-[90%] rounded-xl border border-white/20 shadow-2xl overflow-hidden flex-col">

                {/* Header */}
                <View className="p-4 border-b border-white/10 flex-row justify-between items-center bg-[#252525]">
                    <Text className="text-white text-xl font-bold">Load Data</Text>
                    <TouchableOpacity onPress={onClose}>
                        <Text className="text-gray-400 text-lg font-bold hover:text-white">✕</Text>
                    </TouchableOpacity>
                </View>

                <ScrollView className="p-6 flex-1">

                    {viewMode === 'initial' && (
                        <>
                            {/* Section 1: Auto-BIDS */}
                            <View className="mb-8 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                                <Text className="text-blue-400 font-bold mb-2">Option A: Auto-Scan BIDS Root Folder</Text>
                                <Text className="text-gray-300 text-sm mb-4">
                                    Select the **ROOT BIDS FOLDER** (or Subject Folder) that contains both "rawdata" and "derivatives".
                                </Text>
                                <TouchableOpacity
                                    onPress={() => directoryInputRef.current.click()}
                                    className="bg-blue-600 p-3 rounded items-center active:bg-blue-700"
                                >
                                    <Text className="text-white font-bold">Select Root Folder</Text>
                                </TouchableOpacity>
                                {/* Hidden Directory Input */}
                                <input
                                    type="file"
                                    ref={directoryInputRef}
                                    style={{ display: 'none' }}
                                    webkitdirectory=""
                                    directory=""
                                    onChange={handleDirectoryScan}
                                />
                                <TouchableOpacity
                                    onPress={() => setShowHelp(true)}
                                    className="mt-4"
                                >
                                    <Text className="text-blue-400 underline text-xs text-center">View Example Folder Structure</Text>
                                </TouchableOpacity>
                            </View>

                            <Modal visible={showHelp} transparent animationType="fade">
                                <View className="flex-1 bg-black/90 items-center justify-center p-8">
                                    <View className="bg-white p-2 rounded-lg relative">
                                        <TouchableOpacity
                                            onPress={() => setShowHelp(false)}
                                            className="absolute -top-12 right-0 bg-white/10 p-2 rounded-full"
                                        >
                                            <Text className="text-white font-bold text-xl">Close ✕</Text>
                                        </TouchableOpacity>
                                        <Image
                                            source={require('../assets/exampleDataStructure.png')}
                                            style={{ width: 800, height: 600, resizeMode: 'contain' }}
                                        />
                                    </View>
                                </View>
                            </Modal>

                            {/* Divider */}
                            <View className="flex-row items-center mb-6">
                                <View className="flex-1 h-[1px] bg-white/10"></View>
                                <Text className="mx-4 text-gray-500 font-bold">OR</Text>
                                <View className="flex-1 h-[1px] bg-white/10"></View>
                            </View>

                            {/* Section 2: Manual Selection Trigger */}
                            <View className="items-center">
                                <TouchableOpacity onPress={() => setViewMode('manual')}>
                                    <Text className="text-gray-400 underline">Option B: Select Files Manually (Skip Scan)</Text>
                                </TouchableOpacity>
                            </View>
                        </>
                    )}

                    {viewMode === 'subjectList' && renderSubjectList()}

                    {viewMode === 'manual' && (
                        <View>
                            <View className="flex-row items-center mb-4">
                                <TouchableOpacity onPress={() => setViewMode('initial')} className="mr-2">
                                    <Text className="text-blue-400">Back</Text>
                                </TouchableOpacity>
                                <Text className="text-white font-bold ml-2">
                                    {selectedSubjectId ? `Review Files for ${selectedSubjectId}` : 'Select Files Manually'}
                                </Text>
                            </View>

                            {renderStatus(files.flairStar, 'FLAIRSTAR (Required)')}
                            {renderStatus(files.lesion, 'Lesion Mask (Required)')}
                            {renderStatus(files.swi, 'SWI')}
                            {renderStatus(files.flair, 'FLAIR')}
                            {renderStatus(files.phase, 'Phase')}

                            {/* Hidden Inputs */}
                            <input type="file" ref={fileInputRefs.flairStar} onChange={(e) => handleFileChange('flairStar', e)} style={{ display: 'none' }} accept=".nii,.nii.gz" />
                            <input type="file" ref={fileInputRefs.lesion} onChange={(e) => handleFileChange('lesion', e)} style={{ display: 'none' }} accept=".nii,.nii.gz" />
                            <input type="file" ref={fileInputRefs.swi} onChange={(e) => handleFileChange('swi', e)} style={{ display: 'none' }} accept=".nii,.nii.gz" />
                            <input type="file" ref={fileInputRefs.flair} onChange={(e) => handleFileChange('flair', e)} style={{ display: 'none' }} accept=".nii,.nii.gz" />
                            <input type="file" ref={fileInputRefs.phase} onChange={(e) => handleFileChange('phase', e)} style={{ display: 'none' }} accept=".nii,.nii.gz" />
                        </View>
                    )}

                    {loadingMsg ? (
                        <View className="mt-4">
                            <Text className="text-white text-center mb-2 font-mono whitespace-pre-wrap">{loadingMsg}</Text>
                            <View className="h-2 bg-white/10 rounded-full overflow-hidden">
                                <View
                                    className="h-full bg-blue-500 transition-all duration-300"
                                    style={{ width: `${progress}%` }}
                                />
                            </View>
                        </View>
                    ) : null}

                </ScrollView>

                {/* Footer */}
                <View className="p-4 border-t border-white/10 bg-[#252525] flex-row justify-end gap-3">
                    <TouchableOpacity onPress={onClose} className="px-4 py-2 rounded bg-white/10">
                        <Text className="text-white">Cancel</Text>
                    </TouchableOpacity>

                    {viewMode === 'manual' && (
                        <TouchableOpacity
                            onPress={handleLoadClick}
                            className={`px-6 py-2 rounded ${(!files.flairStar || !files.lesion) ? 'bg-gray-600 opacity-50' : 'bg-green-600 active:bg-green-700'}`}
                            disabled={!files.flairStar || !files.lesion}
                        >
                            <Text className="text-white font-bold">Load Data</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>
        </View >
    );
}
