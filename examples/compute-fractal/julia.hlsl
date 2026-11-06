// A compute program: a Julia set, smoothly coloured, written into a texture one thread per texel.
// fxc /T cs_5_0 /E main julia.hlsl
cbuffer Fractal : register(b0)
{
    float2 c = float2(-0.8, 0.156);           // the Julia constant
    float2 centre = float2(0.0, 0.0);
    float  zoom = 1.2;        // 0.5 .. 50
    uint   iterations = 160;  // 16 .. 512
    float  time = 0.0;
    float  hueShift = 0.0;    // 0 .. 1
};

RWTexture2D<unorm float4> output : register(u0);

float3 palette(float t)
{
    return 0.5 + 0.5 * cos(6.2831853 * (float3(1.0, 1.0, 1.0) * t + float3(0.0, 0.33, 0.67) + hueShift));
}

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID)
{
    uint width, height;
    output.GetDimensions(width, height);
    if (id.x >= width || id.y >= height)
        return;
    float2 z = (float2(id.xy) - 0.5 * float2(width, height)) / (0.5 * height * zoom) + centre;
    float2 k = c + 0.02 * float2(cos(time * 0.3), sin(time * 0.4));
    uint n = 0;
    for (; n < iterations && dot(z, z) < 256.0; ++n)
        z = float2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + k;
    float smooth = n == iterations ? 0.0 : (float(n) - log2(log2(dot(z, z))) + 4.0) / float(iterations);
    float3 rgb = n == iterations ? float3(0.02, 0.02, 0.04) : palette(sqrt(smooth) * 1.5);
    output[id.xy] = float4(rgb, 1.0);
}
