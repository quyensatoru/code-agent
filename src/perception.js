// Stage 1 of the two-stage pipeline: a dedicated perception/omni model
// (default nvidia/nemotron-3-nano-omni) ingests media — screenshots, documents,
// audio, video — and emits a faithful text description (OCR + describe +
// analyze). That text is then fed to the text-only planner model (stage 2), so
// the planner never needs to be multimodal.

export const PERCEPTION_PROMPT = `You are a perception module for a coding/reasoning agent. You receive media (screenshots, documents, audio, video) and must extract everything the downstream agent needs to act correctly.

For EACH attachment, in order, output a section:
- Label: type and a short title.
- OCR / Transcript: ALL text verbatim — code, stack traces, error messages, UI labels, numbers, spoken words. Preserve exact spelling, casing, and symbols.
- Describe: what it shows — layout, UI elements, diagram structure, chart values, speakers, scene.
- Analyze: anomalies, errors, or details likely relevant to a software task.

Be faithful and complete. Do not invent content that is not present. Do not solve the user's task — only report what the media contains. Output plain markdown grouped per attachment.`;

export async function perceive({
    client,
    model,
    parts,
    instruction,
    plugins,
    signal,
    temperature = 0.2,
}) {
    const messages = [
        { role: 'system', content: PERCEPTION_PROMPT },
        {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text:
                        instruction ||
                        'Extract context from the attached media for a downstream coding agent.',
                },
                ...parts,
            ],
        },
    ];

    const response = await client.chat({ model, messages, temperature, plugins, signal });
    return response.choices?.[0]?.message?.content || '';
}
