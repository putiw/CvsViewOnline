// Iterative Union-Find based Connected Component Labeling (3D)
// Connectivity = 26 (includes diagonals)

export const findConnectedComponents = (data, dims) => {
    const [width, height, depth] = dims;
    const size = width * height * depth;
    const labels = new Int32Array(size); // 0 = background
    let nextLabel = 1;
    const parent = new Int32Array(size); // Pre-allocate for Union-Find efficiency

    // Union-Find Operations
    const find = (i) => {
        while (i !== parent[i]) {
            parent[i] = parent[parent[i]]; // path compression
            i = parent[i];
        }
        return i;
    };

    const union = (i, j) => {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
            if (rootI < rootJ) parent[rootJ] = rootI;
            else parent[rootI] = rootJ;
        }
    };

    const getIndex = (x, y, z) => x + y * width + z * width * height;

    // Neighbors (13 neighbors for 26-connectivity in first pass)
    // We only check already visited neighbors (previous in scan order)
    const neighbors = [
        [-1, -1, -1], [0, -1, -1], [1, -1, -1],
        [-1, 0, -1], [0, 0, -1], [1, 0, -1],
        [-1, 1, -1], [0, 1, -1], [1, 1, -1],
        [-1, -1, 0], [0, -1, 0], [1, -1, 0],
        [-1, 0, 0]
    ];

    // Pass 1: Assign provisional labels
    for (let z = 0; z < depth; z++) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = getIndex(x, y, z);
                if (data[idx] > 0.5) { // Threshold > 0.5
                    let neighborLabels = [];

                    for (let n of neighbors) {
                        const nx = x + n[0];
                        const ny = y + n[1];
                        const nz = z + n[2];

                        if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < depth) {
                            const nIdx = getIndex(nx, ny, nz);
                            if (labels[nIdx] > 0) {
                                neighborLabels.push(labels[nIdx]);
                            }
                        }
                    }

                    if (neighborLabels.length === 0) {
                        labels[idx] = nextLabel;
                        parent[nextLabel] = nextLabel;
                        nextLabel++;
                    } else {
                        let minLabel = neighborLabels[0];
                        for (let l of neighborLabels) {
                            if (l < minLabel) minLabel = l;
                        }
                        labels[idx] = minLabel;
                        for (let l of neighborLabels) {
                            union(l, minLabel);
                        }
                    }
                }
            }
        }
    }

    // Pass 2: Resolve labels
    const labelMap = new Map();
    let finalLabelCount = 0;

    // Remap roots to continuous 1..N
    for (let i = 1; i < nextLabel; i++) {
        if (parent[i] === i) {
            finalLabelCount++;
            labelMap.set(i, finalLabelCount);
        }
    }

    // Calculate centroids and re-write final labels
    const centroids = new Map(); // label -> {xSum, ySum, zSum, count}

    for (let i = 0; i < size; i++) {
        if (labels[i] > 0) {
            const root = find(labels[i]);
            if (labelMap.has(root)) { // Should always be true
                const finalLabel = labelMap.get(root);
                labels[i] = finalLabel;

                // Accumulate for centroid
                let z = Math.floor(i / (width * height));
                let rem = i % (width * height);
                let y = Math.floor(rem / width);
                let x = rem % width;

                if (!centroids.has(finalLabel)) {
                    centroids.set(finalLabel, { x: 0, y: 0, z: 0, count: 0 });
                }
                const c = centroids.get(finalLabel);
                c.x += x;
                c.y += y;
                c.z += z;
                c.count++;
            } else {
                labels[i] = 0; // Should not happen
            }
        }
    }

    // Finalize centroids
    const lesionList = [];
    centroids.forEach((val, key) => {
        if (val.count > 10) { // arbitrary min size filter (similar to MATLAB < 5ml check but simplified)
            lesionList.push({
                id: key,
                x: Math.round(val.x / val.count),
                y: Math.round(val.y / val.count),
                z: Math.round(val.z / val.count),
                volume: val.count
            });
        }
    });

    return {
        labeledMask: labels,
        lesions: lesionList.sort((a, b) => b.volume - a.volume) // Sort by size desc
    };
};
