// Paraphrased from Alibaba Cloud's Wan 3.0 guide, adapted to this app's
// supplied image/voice inputs and API Mart's reference-only contract.
export const wanPromptGuideSource = "https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-prompt-guide";
export const wanPromptGuideVersion = 2;
export const wanReferencePromptGuidance = `Wan 3.0 reference-video prompting:
Open with the scene's intent and mood. Organize actions by subject, environment, motion, composition, camera and lighting. State which supplied reference controls identity, setting, object or voice; borrow only that role. Keep subjects identifiable across shots.
For continuous action, explicitly request one continuous shot. Otherwise number shots and name transitions. Fixed-length shots may use consecutive time ranges; automatic duration uses ordered shots without hard timestamps. Use feasible motion and natural pacing.
Write each spoken line as Speaker says/whispers/replies: "exact scripted words". Preserve the script's language and speaker. Use supplied voice samples for timbre, not their spoken content; request lip sync for visible speech. For a silent script, specify no dialogue.
Describe relevant ambience. Follow requested music or silence; do not invent lyrics or voiceover. Keep style coherent. Add only relevant exclusions, without a repetitive negative list.
Use character/reference names in your output, never numbered media labels: the server assigns actual supplied inputs in order.`;
