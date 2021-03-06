/// <reference path="../math.ts" />
/// <reference path="context.ts" />
/// <reference path="utils.ts" />
/// <reference path="bone.ts" />
/// <reference path="skeleton.ts" />
/// <reference path="animation.ts" />
/// <reference path="animation_channel.ts" />

module COLLADA.Converter {

    export interface AnimationLabel {
        name: string;
        begin: number;
        end: number;
        fps: number;
    }

    export class AnimationDataTrack {
        /** Position (relative to parent) */
        pos: Float32Array;
        /** Rotation (relative to parent) */
        rot: Float32Array;
        /** Scale (relative to parent) */
        scl: Float32Array;
        /** Position (relative to rest pose) */
        rel_pos: Float32Array;
        /** Rotation (relative to rest pose) */
        rel_rot: Float32Array;
        /** Scale (relative to rest pose) */
        rel_scl: Float32Array;

        constructor() {
            this.pos = null;
            this.rot = null;
            this.scl = null;
            this.rel_pos = null;
            this.rel_rot = null;
            this.rel_scl = null;
        }
    }

    function logStatistics(name: string, stat: Statistics, precision: number, context: Context): void {
        context.log.write(name + ": "
            + stat.mean().toFixed(precision)
            + " ("
            + "min: " + stat.min().toFixed(precision)
            + ", "
            + "med: " + stat.median().toFixed(precision)
            + ", "
            + "max: " + stat.max().toFixed(precision)
            + ")",
            LogLevel.Debug);
    };

    export class AnimationData {
        name: string;
        duration: number;
        keyframes: number;
        fps: number;
        original_fps: number;
        tracks: COLLADA.Converter.AnimationDataTrack[];

        constructor() {
            this.name = "";
            this.duration = null;
            this.keyframes = null;
            this.fps = null;
            this.tracks = [];
        }

        static create(skeleton: COLLADA.Converter.Skeleton, animation: COLLADA.Converter.Animation, index_begin: number, index_end: number, fps: number, context: COLLADA.Converter.Context): COLLADA.Converter.AnimationData {
            var result: COLLADA.Converter.AnimationData = new COLLADA.Converter.AnimationData();
            result.name = animation.name;

            var src_channels: COLLADA.Converter.AnimationChannel[] = animation.channels;

            // Get timeline statistics
            var stat: COLLADA.Converter.AnimationTimeStatistics = new COLLADA.Converter.AnimationTimeStatistics();
            COLLADA.Converter.Animation.getTimeStatistics(animation, index_begin, index_end, stat, context);


            logStatistics("Original Duration", stat.duration, 3, context);
            logStatistics("Original Time Start", stat.beginTime, 3, context);
            logStatistics("Original Time Stop", stat.endTime, 3, context);
            logStatistics("Original Keyframes", stat.keyframes, 3, context);
            logStatistics("Original FPS", stat.fps, 3, context);

            // Default fps if none give: median fps of source data
            if (fps === null) {
                fps = stat.fps.median();
            }
            if (fps === null || fps <= 0) {
                context.log.write("Could not determine FPS for animation, skipping animation", LogLevel.Warning);
                return null;
            }

            // Duration (in seconds)
            var start_time: number = stat.beginTime.min();
            var end_time: number = stat.endTime.max();
            var duration: number = end_time - start_time;

            // Keyframes
            var keyframes: number = Math.max(Math.floor(fps * duration + 1e-4) + 1, 2);
            if (context.options.truncateResampledAnimations.value) {
                // Truncate duration, so that FPS is consistent with "keyframes/duration"
                duration = (keyframes - 1) / fps;
            } else {
                // Stretch FPS, so that FPS is consistent with "keyframes/duration"
                fps = (keyframes - 1) / duration;
            }
            var spf: number = 1 / fps;

            context.log.write("Resampled duration: " + duration.toFixed(3), LogLevel.Debug);
            context.log.write("Resampled keyframes: " + keyframes.toFixed(3), LogLevel.Debug);
            context.log.write("Resampled FPS: " + fps.toFixed(3), LogLevel.Debug);

            // Store fps
            result.fps = +fps.toFixed(3);
            result.keyframes = keyframes;
            result.duration = duration;
            result.original_fps = stat.fps.median();

            if (!(fps > 0)) {
                context.log.write("Invalid FPS: " + fps + ", skipping animation", LogLevel.Warning);
                return null;
            }
            if (!(duration > 0)) {
                context.log.write("Invalid duration: " + duration + ", skipping animation", LogLevel.Warning);
                return null;
            }
            if (!(keyframes > 0)) {
                context.log.write("Invalid number of keyframes: " + keyframes + ", skipping animation", LogLevel.Warning);
                return null;
            }

            // Init result
            for (var i: number = 0; i < skeleton.bones.length; ++i) {
                var bone: COLLADA.Converter.Bone = skeleton.bones[i];
                var track: COLLADA.Converter.AnimationDataTrack = new COLLADA.Converter.AnimationDataTrack();

                track.pos = new Float32Array(keyframes * 3);
                track.rot = new Float32Array(keyframes * 4);
                track.scl = new Float32Array(keyframes * 3);

                track.rel_pos = new Float32Array(keyframes * 3);
                track.rel_rot = new Float32Array(keyframes * 4);
                track.rel_scl = new Float32Array(keyframes * 3);

                result.tracks.push(track);
            }
            var result_tracks: COLLADA.Converter.AnimationDataTrack[] = result.tracks;

            // Reset the bone poses
            for (var i: number = 0; i < skeleton.bones.length; ++i) {
                var bone: COLLADA.Converter.Bone = skeleton.bones[i];
                bone.node.resetAnimation();
            }

            // Process all keyframes
            var pos: Vec3 = vec3.create();
            var rot: Quat = quat.create();
            var scl: Vec3 = vec3.create();
            for (var k: number = 0; k < keyframes; ++k) {
                var time: number = start_time + k * spf;

                // Apply all channels to the scene nodes
                // This might be expensive as it resamples the animation
                for (var c: number = 0; c < src_channels.length; ++c) {
                    var channel: COLLADA.Converter.AnimationChannel = src_channels[c];
                    if (channel) {
                        channel.target.applyAnimation(channel, time, context);
                    }
                }

                // Extract bone poses
                for (var b: number = 0; b < skeleton.bones.length; ++b) {
                    var bone: COLLADA.Converter.Bone = skeleton.bones[b];
                    var track: COLLADA.Converter.AnimationDataTrack = result_tracks[b];

                    var mat: Mat4 = bone.node.getLocalMatrix(context);
                    COLLADA.MathUtils.decompose(mat, pos, rot, scl);
                    var mat2: Mat4 = mat4.create();
                    mat4.fromRotationTranslation(mat2, rot, pos);

                    if (track.pos !== null) {
                        track.pos[k * 3 + 0] = pos[0];
                        track.pos[k * 3 + 1] = pos[1];
                        track.pos[k * 3 + 2] = pos[2];
                    }
                    if (track.rot !== null) {
                        track.rot[k * 4 + 0] = rot[0];
                        track.rot[k * 4 + 1] = rot[1];
                        track.rot[k * 4 + 2] = rot[2];
                        track.rot[k * 4 + 3] = rot[3];
                    }
                    if (track.scl !== null) {
                        track.scl[k * 3 + 0] = scl[0];
                        track.scl[k * 3 + 1] = scl[1];
                        track.scl[k * 3 + 2] = scl[2];
                    }
                }
            }

            // Reset the bone poses
            for (var i: number = 0; i < skeleton.bones.length; ++i) {
                var bone: COLLADA.Converter.Bone = skeleton.bones[i];
                bone.node.resetAnimation();
            }

            // Remove unnecessary tracks
            var output_relative: boolean = false;
            var pos0: Vec3 = vec3.create();
            var inv_pos0: Vec3 = vec3.create();
            var rot0: Quat = quat.create();
            var inv_rot0: Quat = quat.create();
            var scl0: Vec3 = vec3.create();
            var inv_scl0: Vec3 = vec3.create();
            for (var b: number = 0; b < skeleton.bones.length; ++b) {
                var bone: COLLADA.Converter.Bone = skeleton.bones[b];
                var track: COLLADA.Converter.AnimationDataTrack = result_tracks[b];

                // Get rest pose transformation of the current bone
                var mat0: Mat4 = bone.node.getLocalMatrix(context);
                COLLADA.MathUtils.decompose(mat0, pos0, rot0, scl0);

                quat.invert(inv_rot0, rot0);
                vec3.negate(inv_pos0, pos0);
                vec3.set(inv_scl0, 1 / scl0[0], 1 / scl0[1], 1 / scl0[2]);

                // Check whether there are any changes to the rest pose
                var pos_change: number = 0;
                var rot_change: number = 0;
                var scl_change: number = 0;
                var max_pos_change: number = 0; // max length
                var max_rot_change: number = 0; // max rotation angle (in radians)
                var max_scl_change: number = 0; // max scale along any axis

                for (var k: number = 0; k < keyframes; ++k) {

                    // Relative position
                    pos[0] = track.pos[k * 3 + 0];
                    pos[1] = track.pos[k * 3 + 1];
                    pos[2] = track.pos[k * 3 + 2];
                    vec3.add(pos, inv_pos0, pos);
                    pos_change = vec3.length(pos);
                    max_pos_change = Math.max(max_pos_change, pos_change);

                    // Relative rotation
                    rot[0] = track.rot[k * 4 + 0];
                    rot[1] = track.rot[k * 4 + 1];
                    rot[2] = track.rot[k * 4 + 2];
                    rot[3] = track.rot[k * 4 + 3];
                    quat.multiply(rot, inv_rot0, rot);
                    rot_change = 2 * Math.acos(Math.min(Math.max(rot[3], -1), 1));
                    max_rot_change = Math.max(max_rot_change, rot_change);

                    // Relative scale
                    scl[0] = track.scl[k * 3 + 0];
                    scl[1] = track.scl[k * 3 + 1];
                    scl[2] = track.scl[k * 3 + 2];
                    vec3.multiply(scl, inv_scl0, scl);
                    scl_change = Math.max(Math.abs(1 - scl[0]), Math.abs(1 - scl[1]), Math.abs(1 - scl[2]));
                    max_scl_change = Math.max(max_scl_change, scl_change);

                    // Store relative transformations
                    track.rel_pos[k * 3 + 0] = pos[0];
                    track.rel_pos[k * 3 + 1] = pos[1];
                    track.rel_pos[k * 3 + 2] = pos[2];

                    track.rel_scl[k * 3 + 0] = scl[0];
                    track.rel_scl[k * 3 + 1] = scl[1];
                    track.rel_scl[k * 3 + 2] = scl[2];

                    track.rel_rot[k * 4 + 0] = rot[0];
                    track.rel_rot[k * 4 + 1] = rot[1];
                    track.rel_rot[k * 4 + 2] = rot[2];
                    track.rel_rot[k * 4 + 3] = rot[3];
                }

                // Delete tracks that do not contain any animation
                if (context.options.removeConstAnimationTracks.value === true) {
                    // TODO: This needs better tolerances.
                    // TODO: Maybe use relative instead of absolute tolerances?
                    // TODO: For COLLADA files that use matrix animations, the decomposition will have low precision
                    // TODO: and scale will have an absolute error of >1e-2 even if the scale never changes in the original modelling application.
                    var tol_pos: number = 1e-4;
                    var tol_rot: number = 0.05; // 0.05 radians (2.86 degrees) rotation
                    var tol_scl: number = 0.5; // 5% scaling
                    if (max_pos_change < tol_pos) {
                        track.pos = null;
                        track.rel_pos = null;
                    }
                    if (max_rot_change < tol_rot) {
                        track.rot = null;
                        track.rel_rot = null;
                    }
                    if (max_scl_change < tol_scl) {
                        track.scl = null;
                        track.rel_scl = null;
                    }
                }
            }

            return result;
        }

        static createFromLabels(skeleton: COLLADA.Converter.Skeleton, animation: COLLADA.Converter.Animation,
            labels: COLLADA.Converter.AnimationLabel[], defaultFps: number, context: COLLADA.Converter.Context): COLLADA.Converter.AnimationData[]{

            if (skeleton === null) {
                context.log.write("No skeleton present, no animation data generated.", LogLevel.Warning);
                return [];
            }

            var result: COLLADA.Converter.AnimationData[] = [];

            for (var i: number = 0; i < labels.length; ++i) {
                var label: COLLADA.Converter.AnimationLabel = labels[i];
                var data: COLLADA.Converter.AnimationData = COLLADA.Converter.AnimationData.create(skeleton, animation, label.begin, label.end, label.fps || defaultFps, context);
                if (data !== null) {
                    data.name = label.name;
                    result.push(data);
                }
            }

            return result;
        }
    }
}