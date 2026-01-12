import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Slider from '@react-native-community/slider';

export default function SliceViewer({
    label, axis, volumes, dims, pixDims, coords, zoom, windowMin, windowMax, modality, onClick, interactive, showMask, cursor = 'crosshair', fovZoom, boxZoom, currentLesionLabel,
    onSliceChange // New prop for scrolling
}) {
    const canvasRef = useRef(null);

    // Get current slice number based on axis
    const sliceNum = axis === 'x' ? coords.x : axis === 'y' ? coords.y : coords.z;

    // --- Safe Instantiation of Dimensions ---
    const [dimX, dimY, dimZ] = (dims && dims.length >= 3) ? dims : [1, 1, 1];

    // Determine max slice for this axis
    let maxSlice = 1;
    if (axis === 'x') maxSlice = dimX;
    else if (axis === 'y') maxSlice = dimY;
    else maxSlice = dimZ;
    const [pixX, pixY, pixZ] = (typeof pixDims !== 'undefined' && pixDims && pixDims.length >= 3) ? pixDims : [1, 1, 1];
    const { x, y, z } = coords;

    // --- Calculate Aspect Ratio in Component Body ---
    let pixelAspectRatio = 1.0;
    // 0=Sagittal (y, z), 1=Coronal (x, z), 2=Axial (x, y)
    if (axis === 'x') { // Sagittal (Y-Z)
        pixelAspectRatio = (pixZ && pixY) ? pixZ / pixY : 1;
    } else if (axis === 'y') { // Coronal (X-Z)
        pixelAspectRatio = (pixZ && pixX) ? pixZ / pixX : 1;
    } else { // Axial (X-Y)
        pixelAspectRatio = (pixY && pixX) ? pixY / pixX : 1;
    }

    // Safety check for NaN or Infinity
    if (!Number.isFinite(pixelAspectRatio) || pixelAspectRatio <= 0) {
        pixelAspectRatio = 1.0;
    }

    useEffect(() => {
        console.log(`[SliceViewer ${axis}] Rendering with currentLesionLabel=${currentLesionLabel}`);
        const canvas = canvasRef.current;
        if (!canvas || !volumes[modality]) return;

        const ctx = canvas.getContext('2d');

        let fullWidth, fullHeight;
        let getVal;

        if (axis === 'x') { // Sagittal
            fullWidth = dimY;
            fullHeight = dimZ;
            getVal = (i, j) => x + i * dimX + j * dimX * dimY;
        } else if (axis === 'y') { // Coronal
            fullWidth = dimX;
            fullHeight = dimZ;
            getVal = (i, j) => i + y * dimX + j * dimX * dimY;
        } else { // Axial
            fullWidth = dimX;
            fullHeight = dimY;
            getVal = (i, j) => i + j * dimX + z * dimX * dimY;
        }

        // Calculate cursor position
        let cx, cy;
        if (fullWidth > 0 && fullHeight > 0) {
            let vX, vY;
            if (axis === 'x') {
                vX = y;
                vY = fullHeight - 1 - z;
            } else if (axis === 'y') {
                vX = x;
                vY = fullHeight - 1 - z;
            } else {
                vX = x;
                vY = fullHeight - 1 - y;
            }
            cx = vX;
            cy = vY;
        }

        // Determine what region to render
        let renderWidth, renderHeight, startI, startJ;

        if (fovZoom) {
            // Top row: render square FOV based on minimum dimension across all axes
            const minDim = Math.min(dimX, dimY, dimZ);
            const physicalSquareSize = minDim / fovZoom;

            // Compensate for pixel aspect ratio
            renderWidth = Math.ceil(physicalSquareSize);
            renderHeight = Math.ceil(physicalSquareSize / pixelAspectRatio);

            startI = Math.floor(cx - renderWidth / 2);
            startJ = Math.floor(cy - renderHeight / 2);

            // Clamp to image bounds
            startI = Math.max(0, Math.min(fullWidth - renderWidth, startI));
            startJ = Math.max(0, Math.min(fullHeight - renderHeight, startJ));
        } else {
            // Bottom row: render full image
            renderWidth = fullWidth;
            renderHeight = fullHeight;
            startI = 0;
            startJ = 0;
        }

        canvas.width = renderWidth;
        canvas.height = renderHeight;

        // Reset transform for proper rendering
        canvasRef.current.style.transformOrigin = '50% 50%';
        canvasRef.current.style.transform = `scale(1, ${pixelAspectRatio})`;

        const imgData = ctx.createImageData(renderWidth, renderHeight);
        const data = imgData.data;
        const volData = volumes[modality];
        const lesionData = volumes.lesion;

        const wMin = windowMin !== undefined ? windowMin : 0;
        const wMax = windowMax !== undefined ? windowMax : 1000;
        const range = wMax - wMin || 1;

        // Track labels and colors for debugging
        const labelsFound = new Set();
        let greenCount = 0;
        let blueCount = 0;

        for (let j = 0; j < renderHeight; j++) {
            for (let i = 0; i < renderWidth; i++) {
                const sourceI = startI + i;
                const sourceJ = startJ + j;
                const jFlip = fullHeight - 1 - sourceJ;
                const idx = getVal(sourceI, jFlip);
                const val = volData[idx];

                // Window/Level
                let pixelVal = ((val - wMin) / range) * 255;
                if (pixelVal < 0) pixelVal = 0;
                if (pixelVal > 255) pixelVal = 255;

                const pxIdx = (j * renderWidth + i) * 4;

                data[pxIdx] = pixelVal;
                data[pxIdx + 1] = pixelVal;
                data[pxIdx + 2] = pixelVal;
                data[pxIdx + 3] = 255;

                if (showMask && lesionData && lesionData[idx] > 0.5) {
                    const currentLabel = Math.round(lesionData[idx]);
                    labelsFound.add(currentLabel);

                    let isEdge = false;

                    if (sourceI === 0 || sourceI === fullWidth - 1 || jFlip === 0 || jFlip === fullHeight - 1) {
                        isEdge = true;
                    } else {
                        // Check if neighbors have the SAME label
                        const n1 = Math.round(lesionData[getVal(sourceI + 1, jFlip)]) === currentLabel;
                        const n2 = Math.round(lesionData[getVal(sourceI - 1, jFlip)]) === currentLabel;
                        const n3 = Math.round(lesionData[getVal(sourceI, jFlip + 1)]) === currentLabel;
                        const n4 = Math.round(lesionData[getVal(sourceI, jFlip - 1)]) === currentLabel;
                        if (!n1 || !n2 || !n3 || !n4) isEdge = true;
                    }

                    if (isEdge) {
                        // Check if this pixel belongs to the current lesion
                        const lesionLabel = currentLabel;
                        const isCurrentLesion = currentLesionLabel && lesionLabel === currentLesionLabel;

                        // Green (#00ff00) for current lesion, Blue (#60a5fa) for others
                        if (isCurrentLesion) {
                            data[pxIdx] = 0;
                            data[pxIdx + 1] = 255;
                            data[pxIdx + 2] = 0;
                            greenCount++;
                        } else {
                            data[pxIdx] = 96;   // #60a5fa
                            data[pxIdx + 1] = 165;
                            data[pxIdx + 2] = 250;
                            blueCount++;
                        }
                        data[pxIdx + 3] = 255;
                    }
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);

        // Log summary
        if (labelsFound.size > 0) {
            console.log(`[${axis}] Labels in view: [${Array.from(labelsFound).sort().join(', ')}], Current: ${currentLesionLabel}, Green pixels: ${greenCount}, Blue pixels: ${blueCount}`);
        }

        // Draw Cursor (only on bottom row)
        if (cursor === 'crosshair') {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, cy); ctx.lineTo(renderWidth, cy);
            ctx.moveTo(cx, 0); ctx.lineTo(cx, renderHeight);
            ctx.stroke();
        } else if (cursor === 'box' && boxZoom) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;

            const minDim = Math.min(dimX, dimY, dimZ);
            const boxSize = minDim / boxZoom;

            const boxW = boxSize;
            const boxH = boxSize / pixelAspectRatio;

            const halfW = boxW / 2;
            const halfH = boxH / 2;

            ctx.strokeRect(cx - halfW, cy - halfH, boxW, boxH);
        }

    }, [volumes, dims, pixDims, coords, zoom, windowMin, windowMax, modality, axis, showMask, cursor, fovZoom, boxZoom, pixelAspectRatio, dimX, dimY, dimZ, currentLesionLabel]);

    const handlePress = (evt) => {
        if (!interactive || !onClick) return;
        // Interaction logic placeholder
    };

    // Scroll handler (Web)
    const handleWheel = (e) => {
        if (!onSliceChange || maxSlice <= 1) return;

        // e.deltaY > 0 means scrolling down -> next slice
        // e.deltaY < 0 means scrolling up -> prev slice
        const delta = Math.sign(e.deltaY);
        const newSlice = Math.max(0, Math.min(maxSlice - 1, sliceNum + delta));

        if (newSlice !== sliceNum) {
            onSliceChange(newSlice);
        }
    };

    return (
        <View
            className="flex-1 bg-black border border-white/20 relative overflow-hidden flex-col"
            onWheel={handleWheel} // React Native Web passes this through to DOM
        >
            <View className="flex-1 relative">
                <Text className="absolute top-1 left-1 text-white bg-black/50 px-1 text-xs z-10">{label} (Slice {sliceNum})</Text>
                <View className="flex-1 items-center justify-center">
                    <canvas
                        ref={canvasRef}
                        data-scale-y={pixelAspectRatio}
                        style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            imageRendering: 'pixelated',
                        }}
                    />
                </View>
            </View>

            {onSliceChange && (
                <View className="h-6 bg-black/40 w-full justify-center px-1">
                    <Slider
                        style={{ width: '100%', height: 20 }}
                        minimumValue={0}
                        maximumValue={maxSlice - 1}
                        step={1}
                        value={sliceNum}
                        onValueChange={(val) => onSliceChange(val)}
                        minimumTrackTintColor="#3b82f6"
                        maximumTrackTintColor="#ffffff"
                        thumbTintColor="#3b82f6"
                    />
                </View>
            )}
        </View>
    );
}
