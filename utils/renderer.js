
export function renderSliceToDataURL({
    volumes, modality, axis, sliceCoords, dims, pixDims,
    fovZoom, showMask, windowMin, windowMax,
    boxZoom, // Optional: for drawing the box on full views
    ignoreAspectRatio = false // Force isotropic pixels (mostly for full views if headers are weird)
}) {
    const { x, y, z } = sliceCoords;
    const [dimX, dimY, dimZ] = dims;
    const [pixX, pixY, pixZ] = pixDims;

    // 1. Calculate Pixel Aspect Ratio
    let pixelAspectRatio = 1.0;
    if (!ignoreAspectRatio) {
        if (axis === 'x') { // Sagittal (Y-Z)
            pixelAspectRatio = (pixZ && pixY) ? pixZ / pixY : 1;
        } else if (axis === 'y') { // Coronal (X-Z)
            pixelAspectRatio = (pixZ && pixX) ? pixZ / pixX : 1;
        } else { // Axial (X-Y)
            pixelAspectRatio = (pixY && pixX) ? pixY / pixX : 1;
        }
    }
    if (!Number.isFinite(pixelAspectRatio) || pixelAspectRatio <= 0) pixelAspectRatio = 1.0;

    // 2. Setup Loop Variables
    let fullWidth, fullHeight;
    let getVal; // Function to get index

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

    // 3. Cursor/Center determination
    let cx, cy;
    if (axis === 'x') { cx = y; cy = fullHeight - 1 - z; }
    else if (axis === 'y') { cx = x; cy = fullHeight - 1 - z; }
    else { cx = x; cy = fullHeight - 1 - y; }

    // 4. Render Region Calculation
    let renderWidth, renderHeight, startI, startJ;
    let isZoomed = !!fovZoom;

    if (isZoomed) {
        // Zoomed: Square FOV
        const minDim = Math.min(dimX, dimY, dimZ);
        const physicalSquareSize = minDim / fovZoom;
        renderWidth = Math.ceil(physicalSquareSize);
        renderHeight = Math.ceil(physicalSquareSize / pixelAspectRatio);

        startI = Math.floor(cx - renderWidth / 2);
        startJ = Math.floor(cy - renderHeight / 2);

        // Clamp
        startI = Math.max(0, Math.min(fullWidth - renderWidth, startI));
        startJ = Math.max(0, Math.min(fullHeight - renderHeight, startJ));
    } else {
        // Full View
        renderWidth = fullWidth;
        renderHeight = fullHeight;
        startI = 0;
        startJ = 0;
    }

    // 5. Render Core Buffer (Anisotropic)
    // Create an offscreen canvas for the raw buffer
    // Note: In React Native Web, document.createElement('canvas') works
    const bufferCanvas = document.createElement('canvas'); // Small buffer
    bufferCanvas.width = renderWidth;
    bufferCanvas.height = renderHeight;
    const ctx = bufferCanvas.getContext('2d');
    const imgData = ctx.createImageData(renderWidth, renderHeight);
    const data = imgData.data;

    const volData = volumes[modality];
    const lesionData = volumes.lesion;
    const wMin = windowMin ?? 0;
    const wMax = windowMax ?? 1000;
    const range = wMax - wMin || 1;

    if (volData) {
        for (let j = 0; j < renderHeight; j++) {
            for (let i = 0; i < renderWidth; i++) {
                const sourceI = startI + i;
                const sourceJ = startJ + j;
                const jFlip = fullHeight - 1 - sourceJ;

                let val = 0;
                // Boundary check (if startI < 0 logic shouldn't happen due to clamp, but useful if we change logic)
                if (sourceI >= 0 && sourceI < fullWidth && sourceJ >= 0 && sourceJ < fullHeight) {
                    const idx = getVal(sourceI, jFlip);
                    val = volData[idx];

                    // Mask
                    if (showMask && lesionData && lesionData[idx] > 0.5) {
                        // Edge detection simplified
                        // Just draw Green for now to save perf/complexity, or full mask
                        let isEdge = false;
                        // Simple neighboring
                        // To do proper edge we need getVal which needs bounds. 
                        // Let's implement full edge check from Viewer
                        const n1 = (sourceI + 1 < fullWidth) ? lesionData[getVal(sourceI + 1, jFlip)] > 0.5 : false;
                        const n2 = (sourceI - 1 >= 0) ? lesionData[getVal(sourceI - 1, jFlip)] > 0.5 : false;
                        const n3 = (jFlip + 1 < fullHeight) ? lesionData[getVal(sourceI, jFlip + 1)] > 0.5 : false;
                        const n4 = (jFlip - 1 >= 0) ? lesionData[getVal(sourceI, jFlip - 1)] > 0.5 : false;

                        if (!n1 || !n2 || !n3 || !n4) isEdge = true;

                        if (isEdge) {
                            const pxIdx = (j * renderWidth + i) * 4;
                            data[pxIdx] = 0; data[pxIdx + 1] = 255; data[pxIdx + 2] = 0; data[pxIdx + 3] = 255;
                            continue; // Skip grayscale
                        }
                    }
                }

                let pixelVal = ((val - wMin) / range) * 255;
                if (pixelVal < 0) pixelVal = 0;
                if (pixelVal > 255) pixelVal = 255;

                const pxIdx = (j * renderWidth + i) * 4;
                data[pxIdx] = pixelVal;
                data[pxIdx + 1] = pixelVal;
                data[pxIdx + 2] = pixelVal;
                data[pxIdx + 3] = 255;
            }
        }
    }
    ctx.putImageData(imgData, 0, 0);

    // 6. Draw Box if needed (on the buffer? No, box is vector)
    // Box logic assumes visual coordinates.
    if (boxZoom && !isZoomed) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1; // On small buffer, 1px is thick enough
        // But boxCoords need to be in buffer space?
        // cx, cy are in buffer space (fullWidth=renderWidth)

        const minDim = Math.min(dimX, dimY, dimZ);
        const boxSize = minDim / boxZoom;
        const boxW = boxSize;
        const boxH = boxSize / pixelAspectRatio;

        ctx.strokeRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH);
    }

    // 7. Output Canvas (Bake Scaling)
    const targetSize = 512;
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = targetSize;

    if (isZoomed) {
        outputCanvas.height = targetSize; // Square
        // Stretched if needed (ratio applies)
    } else {
        if (ignoreAspectRatio) {
            // Maintain Buffer Aspect Ratio (1:1 pixels)
            // fullWidth / fullHeight
            const bufferAspect = renderWidth / renderHeight;
            // We want to fit into targetSize width, or height?
            // Let's match width to targetSize, and let height scale naturally.
            outputCanvas.height = targetSize / bufferAspect;
        } else {
            // Physical Aspect Ratio scaling
            outputCanvas.height = targetSize * pixelAspectRatio;
        }
    }

    const outCtx = outputCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = false; // Sharp pixels

    // Draw buffer stretched to output
    outCtx.drawImage(bufferCanvas, 0, 0, renderWidth, renderHeight, 0, 0, outputCanvas.width, outputCanvas.height);

    return outputCanvas.toDataURL('image/png');
}
