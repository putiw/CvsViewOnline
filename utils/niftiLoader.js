import * as nifti from 'nifti-reader-js';

export const loadNifti = (arrayBuffer) => {
    if (nifti.isCompressed(arrayBuffer)) {
        arrayBuffer = nifti.decompress(arrayBuffer);
    }

    if (nifti.isNIFTI(arrayBuffer)) {
        const header = nifti.readHeader(arrayBuffer);
        let image = nifti.readImage(header, arrayBuffer);

        // Convert to TypedArray based on datatype code
        // 2=uint8, 4=int16, 8=int32, 16=float32, 64=float64
        let typedData;
        if (header.datatypeCode === 2) {
            typedData = new Uint8Array(image);
        } else if (header.datatypeCode === 4) {
            typedData = new Int16Array(image);
        } else if (header.datatypeCode === 8) {
            typedData = new Int32Array(image);
        } else if (header.datatypeCode === 16) {
            typedData = new Float32Array(image);
        } else if (header.datatypeCode === 64) {
            typedData = new Float64Array(image);
        } else {
            // Fallback or explicit support for others
            typedData = new Int16Array(image); // Most MRI is int16. 
        }

        // Apply Scaling (Slope/Intercept) if present
        // NIfTI spec: if scl_slope is 0, it means 1 (no scaling).
        const slope = header.scl_slope;
        const intercept = header.scl_inter;

        if (slope && slope !== 0) {
            // We must convert to Float32 to hold scaled values
            const scaledData = new Float32Array(typedData.length);
            for (let i = 0; i < typedData.length; i++) {
                scaledData[i] = typedData[i] * slope + intercept;
            }
            typedData = scaledData;
        }

        // Scale to proper values if needed (ignoring scaling for now for raw visualization speed, 
        // but might be needed for quantitative values)
        // nifti-reader-js provides raw typed array.

        return {
            header,
            data: typedData,
            dims: header.dims.slice(1, 4), // [x, y, z]
            pixDims: header.pixDims.slice(1, 4), // [dx, dy, dz]
        };
    }
    return null;
};
