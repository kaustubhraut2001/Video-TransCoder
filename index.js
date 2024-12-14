const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Queue, Worker } = require("bullmq");
const { createClient } = require("redis");
const exec = require("child_process").exec;

const app = express();
const redisConnection = createClient({ url: "redis://localhost:6379" });

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static("uploads"));


function createFolder() {
    const folderNames = ["uploads", "uploads/videos"];
    folderNames.forEach(folderName => {
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


        await videoQueue.add("transcode", { videoPath, videoId });

        res.json({ message: "Video added to the queue for transcoding", videoId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
});


const worker = new Worker("video-transcoding", async(job) => {
    const { videoPath, videoId } = job.data;
    const resolutions = [
        { label: "114p", width: 114, height: 114 },
        // { label: "720p", width: 1280, height: 720 },
        // { label: "1080p", width: 1920, height: 1080 }
    ];

    try {
        console.log(`Processing video: ${videoPath} (${videoId})`);

        const videoBaseDir = path.join(__dirname, "uploads/videos", videoId);


        if (!fs.existsSync(videoBaseDir)) {
            fs.mkdirSync(videoBaseDir, { recursive: true });
        }


        for (const resolution of resolutions) {
            const outputDir = path.join(videoBaseDir, resolution.label);
            const hlsPath = path.join(outputDir, "index.m3u8");

            /* The `createFolder()` function in the provided JavaScript
		   code is responsible for creating specific directories if
		   they do not already exist. It creates two directories:
		   "uploads" and "uploads/videos". */

            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }


            const ffmpegCommand = `
                ffmpeg -i "${videoPath}" -vf scale=${resolution.width}:${resolution.height} \
                -codec:v libx264 -codec:a aac -hls_time 10 -hls_playlist_type vod \
                -hls_segment_filename "${outputDir}/segment%03d.ts" -start_number 0 "${hlsPath}"
            `;

            console.log(`Transcoding to ${resolution.label}...`);
            await new Promise((resolve, reject) => {
                exec(ffmpegCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Error transcoding to ${resolution.label}:`, error);
                        return reject(error);
                    }
                    console.log(`Transcoding to ${resolution.label} completed.`);
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
}, { connection: redisConnection, concurrency: 2 }); // Limit concurrency to prevent overloading the server


worker.on("failed", (job, error) => {
    console.error(`Job ${job.id} failed:`, error);
});

worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed successfully.`);
});


app.listen(3000, () => {
    console.log("Server is running on port 3000");
});