// Calculate percentile value from sorted array
export function calculatePercentile(sortedData, percentile) {
    const index = Math.floor((percentile / 100) * sortedData.length);
    return sortedData[Math.min(index, sortedData.length - 1)];
}

// Calculate 1st and 99th percentiles for contrast windowing
export function calculateContrastPercentiles(data) {
    // Sample the data for performance (use every 100th voxel)
    const sampledData = [];
    for (let i = 0; i < data.length; i += 100) {
        sampledData.push(data[i]);
    }

    // Sort the sampled data
    sampledData.sort((a, b) => a - b);

    const p1 = calculatePercentile(sampledData, 1);
    const p99 = calculatePercentile(sampledData, 99.99);

    return { min: p1, max: p99 };
}

// Z-score normalization
export function zNormalize(data) {
    const n = data.length;

    // Calculate mean
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += data[i];
    }
    const mean = sum / n;

    // Calculate std dev
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
        const diff = data[i] - mean;
        sumSq += diff * diff;
    }
    const std = Math.sqrt(sumSq / n);

    // Normalize
    const normalized = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        normalized[i] = (data[i] - mean) / (std || 1);
    }

    return normalized;
}
