/** Native rigid-fist katana fit. Metres; +shaft is pommel → kissaki, -curl is the edge.
 * Shaft fitted to Mixamo thrust-slash (.70–.80 s); edge fitted to captured sword cuts.
 * The one-handed seat (`gripFromPommel`) puts the closed fist's index side a few millimetres behind the back face of the tsuba (`tsubaBackFromPommel`),
 * like a real one-handed grip: the tsuka between the fist and the guard is only the thin fuchi.
 * The fitted tsuka keeps one slender radius from the pommel ramp up to the fuchi: a collar `fuchi.length` long right behind the tsuba whose radius is `fuchi.scale` times the tsuka's.
 * The fitted handle band stays centred on the tsuka itself (`handleFromPommel`), so the guard and pommel keep their native shape wherever the hand sits.
 * The tsuba is a disc of radius `guardRadius` spanning `guardFromPommel` (measured on the revision-2 mesh, back face at `tsubaBackFromPommel`); clearance checks include it, not only the steel line.
 * Both renderer and offline motion/clearance authoring import this single authority.
 */
export const KATANA_GRIP = Object.freeze({ length: 1.25, gripFromPommel: 0.356, handleFromPommel: 0.20, bladeLength: 0.76, diagonalRadians: 2.45, edgeRadians: 1.18, guardFromPommel: [0.405, 0.445], guardRadius: 0.08, tsubaBackFromPommel: 0.4137, fuchi: Object.freeze({ length: 0.008, scale: 1.35 }) });
