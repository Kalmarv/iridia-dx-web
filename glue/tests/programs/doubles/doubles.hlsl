// A Shader Model 5 pixel program that works in double precision: it sums a long series in doubles, where floats
// would lose the small terms. WebGPU has no doubles, so the page lists and lifts it but writes no WGSL for it.
// fxc /T ps_5_0 /E main doubles.hlsl
cbuffer Series : register(b0)
{
    double start;
    double step;
    uint terms;
};

float4 main(float4 position : SV_Position) : SV_Target
{
    double sum = start;
    double term = step * (double)position.x;
    for (uint i = 0; i < terms; i++)
    {
        sum += term;
        term *= 0.5;
    }
    return float4((float)sum, (float)term, 0, 1);
}
