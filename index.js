const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const exec = require("child_process").exec;

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static("uploads"));

app.get("/", (req, res) => {
    res.send("Hello Word")
});

function createFolder() {
    const folderNames = ["uploads", "uploads/videos"];
    folderNames.forEach(folderName => {
        if (!fs.existsSync(folderName)) {
            fs.mkdirSync(folderName, { recursive: true });
        }
    })
}
createFolder();
const multerconfig = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads");
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname}`;

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: multerconfig,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed!'));
        }
    }
});

app.post("/upload", upload.single("videofile"), async(req, res) => {

    try {
        if (!req.file) {
            res.status(400).json({
                message: "No file uploaded"
            })

        }
        const videoPath = req.file.path;
        const videoId = path.parse(req.file.filename).name;
        const fileName = path.basename(videoPath);
        const outputPath = path.join(__dirname, "uploads/videos", videoId);
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }

        const hlsPath = `${outputPath}/index.m3u8`


        const ffmpegCommand = `ffmpeg -i "${videoPath}" -codec:v libx264 -codec:a aac -hls_time 10 -hls_playlist_type vod -hls_segment_filename "${outputPath}/segment%03d.ts" -start_number 0 "${hlsPath}"`;


        exec(ffmpegCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`FFmpeg error: ${error}`);
                return res.status(500).json({
                    message: "Error converting video",
                    error: error.message
                });
            }
            console.log(`stdout: ${stdout}`)

            fs.unlink(videoPath, (err) => {
                if (err) console.error('Error deleting original file:', err);
            });

            const videoUrl = `http://localhost:3000/uploads/videos/${videoId}/index.m3u8`;

            res.json({
                message: "Video converted to HLS format",
                videoUrl: videoUrl,

            })
        })




    } catch (error) {
        res.status(500).json({
            message: error.message
        })
    }



});



app.listen(3000, () => {
    console.log("Server is running on port 3000");
});