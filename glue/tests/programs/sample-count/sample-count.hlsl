// A Shader Model 5 pixel program that writes the render target's sample count. The count is the pipeline's
// rasterizer state, not the program's, so iridia refuses to lift it, and the page lists it and says why.
// fxc /T ps_5_0 /E main sample-count.hlsl
float4 main() : SV_Target
{
    return float4((float)GetRenderTargetSampleCount(), 0, 0, 1);
}
