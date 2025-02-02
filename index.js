const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Queue, Worker } = require("bullmq");
const IORedis = require("ioredis");
const exec = require("child_process").exec;


const app = express();


const redisConnection = new IORedis("redis://localhost:6379", {
    maxRetriesPerRequest: null,
});


redisConnection.on("error", (err) => console.error("Redis Client Error:", err));
redisConnection.on("connect", () => console.log("Redis connected successfully."));
redisConnection.on("ready", () => console.log("Redis connection ready."));


app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static("uploads"));


function createFolder() {
    const folderNames = ["uploads", "uploads/videos"];
    folderNames.forEach((folderName) => {
        if (!fs.existsSync(folderName)) {
            fs.mkdirSync(folderName, { recursive: true });
        }
    });
}
createFolder();


const multerConfig = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
    storage: multerConfig,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("video/")) {
            cb(null, true);
        } else {
            cb(new Error("Only video files are allowed!"));
        }
    }
});


const videoQueue = new Queue("video-transcoding", { connection: redisConnection });

app.post("/upload", upload.single("videofile"), async(req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No file uploaded" });
        }

        const videoPath = req.file.path;
        const videoId = path.parse(req.file.filename).name;

        console.log(videoPath, videoId, "Upload API endpoint");


        await videoQueue.add("transcode", { videoPath, videoId });
        console.log("Video added to the queue");

        res.json({ message: "Video added to the queue for transcoding", videoId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
});


// const worker = new Worker(
//     "video-transcoding",
//     async(job) => {
//         const { videoPath, videoId } = job.data;
//         console.log(videoId, videoPath, "from worker");

//         const resolutions = [
//             { label: "480p", width: 480, height: 480 },
//             { label: "720p", width: 720, height: 720 },
//             { label: "1080p", width: 1080, height: 1080 }
//         ];

//         try {
//             console.log(`Processing video: ${videoPath} (${videoId})`);

//             const videoBaseDir = path.join(__dirname, "uploads/videos", videoId);
//             if (!fs.existsSync(videoBaseDir)) {
//                 fs.mkdirSync(videoBaseDir, { recursive: true });
//             }

//             for (const resolution of resolutions) {
//                 const outputDir = path.join(videoBaseDir, resolution.label);
//                 const hlsPath = path.join(outputDir, "index.m3u8");
//                 const mp4Path = path.join(outputDir, `${resolution.label}.mp4`); // MP4 file path



//                 if (!fs.existsSync(outputDir)) {
//                     fs.mkdirSync(outputDir, { recursive: true });
//                 }
//                 const ffmpegCommandMP4 = `ffmpeg -i "${videoPath}" -vf scale=${resolution.width}:${resolution.height} \
//                 -c:v libx264 -preset slow -crf 22 -c:a aac "${mp4Path}"`;
//                 // FFmpeg command
//                 const ffmpegCommand = `ffmpeg -i "${videoPath}" -vf scale=${resolution.width}:${resolution.height} \
//                 -c:v libx264 -c:a aac -hls_time 10 -hls_playlist_type vod \
//                 -hls_segment_filename "${outputDir}/segment%03d.ts" -start_number 0 "${hlsPath}"`;

//                 console.log("Executing FFmpeg command:", ffmpegCommand);


//                 await new Promise((resolve, reject) => {
//                     exec(ffmpegCommandMP4, (error, stdout, stderr) => {
//                         if (error) {
//                             console.error(`Error transcoding to ${resolution.label} MP4:`, error);
//                             console.error("FFmpeg stderr:", stderr);
//                             return reject(error);
//                         }
//                         console.log(`MP4 transcoding to ${resolution.label} completed.`);
//                         resolve();
//                     });
//                 });

//                 await new Promise((resolve, reject) => {
//                     exec(ffmpegCommand, (error, stdout, stderr) => {
//                         if (error) {
//                             console.error(`Error transcoding to ${resolution.label}:`, error);
//                             console.error("FFmpeg stderr:", stderr);
//                             return reject(error);
//                         }
//                         console.log(`FFmpeg stdout: ${stdout}`);

//                         console.log(`Transcoding to ${resolution.label} completed.`);
//                         resolve();
//                     });
//                 });
//             }


//             fs.unlink(videoPath, (err) => {
//                 if (err) console.error("Error deleting original file:", err);
//             });

//             console.log(`Video ${videoId} transcoded successfully.`);
//         } catch (error) {
//             console.error(`Error processing video ${videoId}:`, error);
//             throw error;
//         }
//     }, { connection: redisConnection, concurrency: 3 }
// );

const worker = new Worker(
    "video-transcoding",
    async(job) => {
        const { videoPath, videoId } = job.data;
        console.log(videoId, videoPath, "from worker");


        const resolutions = [
            { label: "480p", width: 854, height: 480 },
            { label: "720p", width: 1280, height: 720 },
            { label: "1080p", width: 1920, height: 1080 }
        ];

        try {
            console.log(`Processing video: ${videoPath} (${videoId})`);

            const videoBaseDir = path.join(__dirname, "uploads/videos", videoId);
            if (!fs.existsSync(videoBaseDir)) {
                fs.mkdirSync(videoBaseDir, { recursive: true });
            }


            const probeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json "${videoPath}"`;
            const videoInfo = await new Promise((resolve, reject) => {
                exec(probeCommand, (error, stdout) => {
                    if (error) reject(error);
                    resolve(JSON.parse(stdout));
                });
            });

            const inputWidth = videoInfo.streams[0].width;
            const inputHeight = videoInfo.streams[0].height;

            for (const resolution of resolutions) {
                if (resolution.height < inputHeight) {
                    console.log(`Skipping ${resolution.label} - lower than input resolution`);
                    continue;
                }

                const outputDir = path.join(videoBaseDir, resolution.label);
                const hlsPath = path.join(outputDir, "index.m3u8");
                const mp4Path = path.join(outputDir, `${resolution.label}.mp4`);

                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }

                const ffmpegCommandMP4 = `ffmpeg -i "${videoPath}" \
                    -vf "scale=${resolution.width}:${resolution.height}:flags=lanczos,unsharp=3:3:1.5:3:3:0.7" \
                    -c:v libx264 \
                    -preset slower \
                    -profile:v high \
                    -crf 18 \
                    -maxrate 5M \
                    -bufsize 10M \
                    -c:a aac \
                    -b:a 192k \
                    -movflags +faststart \
                    "${mp4Path}"`;

                const ffmpegCommandHLS = `ffmpeg -i "${videoPath}" \
                    -vf "scale=${resolution.width}:${resolution.height}:flags=lanczos,unsharp=3:3:1.5:3:3:0.7" \
                    -c:v libx264 \
                    -preset slower \
                    -profile:v high \
                    -crf 18 \
                    -maxrate 5M \
                    -bufsize 10M \
                    -c:a aac \
                    -b:a 192k \
                    -hls_time 6 \
                    -hls_playlist_type vod \
                    -hls_segment_filename "${outputDir}/segment%03d.ts" \
                    "${hlsPath}"`;

                console.log(`Processing ${resolution.label}...`);


                await new Promise((resolve, reject) => {
                    exec(ffmpegCommandMP4, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`Error transcoding to ${resolution.label} MP4:`, error);
                            return reject(error);
                        }
                        console.log(`MP4 transcoding to ${resolution.label} completed.`);
                        resolve();
                    });
                });


                await new Promise((resolve, reject) => {
                    exec(ffmpegCommandHLS, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`Error transcoding to ${resolution.label} HLS:`, error);
                            return reject(error);
                        }
                        console.log(`HLS transcoding to ${resolution.label} completed.`);
                        resolve();
                    });
                });
            }

            fs.unlink(videoPath, (err) => {
                if (err) console.error("Error deleting original file:", err);
            });

            console.log(`Video ${videoId} transcoded successfully.`);
        } catch (error) {
            console.error(`Error processing video ${videoId}:`, error);
            throw error;
        }
    }, { connection: redisConnection, concurrency: 2 }
);
worker.on("failed", (job, error) => {
    console.error(`Job ${job.id} failed:`, error);
});

worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed successfully.`);
});


app.listen(3000, () => {
    console.log("Server is running on port 3000");
});