require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createWriteStream } = require('fs');

const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 5000;
const downloadsDir = path.join(__dirname, 'downloads');
const ffmpegDir = path.join(__dirname, 'ffmpeg');
const ffmpegPath = path.join(ffmpegDir, 'bin', 'ffmpeg.exe');

[downloadsDir, ffmpegDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Pragma'],
    credentials: false 
}));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, Cache-Control, Pragma');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} from ${req.get('origin') || 'no-origin'}`);
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const sanitizeFilename = (filename) => {
    return filename
        .replace(/[^\w\s\-_\.]/gi, '')
        .replace(/\s+/g, '_')
        .replace(/_{2,}/g, '_')
        .substring(0, 100)
        .trim();
};

const formatDuration = (seconds) => {
    if (!seconds) return 'N/A';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const validateYouTubeURL = (url) => {
    if (!url) return false;
    try {
        const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)[\w-]+/;
        return youtubeRegex.test(url);
    } catch (error) {
        console.error('URL validation error:', error);
        return false;
    }
};

const formatFileSize = (bytes) => {
    if (!bytes) return 'Unknown';
    const gb = bytes / (1024 * 1024 * 1024);
    const mb = bytes / (1024 * 1024);
    
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
};

// Enhanced yt-dlp command builder with anti-bot measures
const buildYtDlpCommand = (url, options = {}) => {
    const baseArgs = [
        'yt-dlp',
        '--no-warnings',
        '--no-check-certificate',
        '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"',
        '--referer "https://www.youtube.com/"',
        '--add-header "Accept-Language:en-US,en;q=0.9"',
        '--add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"',
        '--add-header "Accept-Encoding:gzip, deflate, br"',
        '--add-header "DNT:1"',
        '--add-header "Connection:keep-alive"',
        '--add-header "Upgrade-Insecure-Requests:1"',
        '--sleep-interval 1',
        '--max-sleep-interval 3'
    ];

    // Add cookies if available
    const cookiePath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiePath)) {
        baseArgs.push(`--cookies "${cookiePath}"`);
    }

    // Add specific options
    if (options.dumpJson) {
        baseArgs.push('--dump-json');
    }
    
    if (options.format) {
        baseArgs.push(`-f ${options.format}`);
    }
    
    if (options.ffmpegLocation) {
        baseArgs.push(`--ffmpeg-location "${options.ffmpegLocation}"`);
    }
    
    if (options.extractAudio) {
        baseArgs.push('--extract-audio');
        baseArgs.push(`--audio-format ${options.audioFormat || 'mp3'}`);
    }
    
    if (options.output) {
        baseArgs.push(`-o "${options.output}"`);
    }

    baseArgs.push(`"${url}"`);
    
    return baseArgs.join(' ');
};

// Create cookies.txt if it doesn't exist
const createCookiesFile = () => {
    const cookiePath = path.join(__dirname, 'cookies.txt');
    if (!fs.existsSync(cookiePath)) {
        const cookieContent = `# Netscape HTTP Cookie File
# This is a generated file! Do not edit.

youtube.com	FALSE	/	TRUE	0	CONSENT	YES+cb
.youtube.com	TRUE	/	FALSE	0	GPS	1
.youtube.com	TRUE	/	FALSE	0	YSC	random_value_here
.youtube.com	TRUE	/	TRUE	0	VISITOR_INFO1_LIVE	random_visitor_info
`;
        fs.writeFileSync(cookiePath, cookieContent);
        console.log('✅ Created basic cookies.txt file');
    }
};

// FFmpeg auto-download function
const downloadFFmpeg = () => {
    return new Promise((resolve, reject) => {
        console.log('📥 Downloading FFmpeg...');
        
        const ffmpegUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
        const zipPath = path.join(ffmpegDir, 'ffmpeg.zip');
        
        const file = createWriteStream(zipPath);
        
        https.get(ffmpegUrl, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                https.get(response.headers.location, (redirectResponse) => {
                    redirectResponse.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        console.log('✅ FFmpeg downloaded successfully');
                        extractFFmpeg(zipPath).then(resolve).catch(reject);
                    });
                });
            } else {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log('✅ FFmpeg downloaded successfully');
                    extractFFmpeg(zipPath).then(resolve).catch(reject);
                });
            }
        }).on('error', (err) => {
            fs.unlink(zipPath, () => {});
            reject(err);
        });
    });
};

const extractFFmpeg = (zipPath) => {
    return new Promise((resolve, reject) => {
        console.log('📦 Extracting FFmpeg...');
        
        const extractCommand = `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${ffmpegDir}' -Force"`;
        
        exec(extractCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ FFmpeg extraction failed:', error);
                return reject(error);
            }
            
            const extractedFolders = fs.readdirSync(ffmpegDir).filter(item => 
                item.startsWith('ffmpeg-') && fs.statSync(path.join(ffmpegDir, item)).isDirectory()
            );
            
            if (extractedFolders.length > 0) {
                const extractedPath = path.join(ffmpegDir, extractedFolders[0]);
                const binPath = path.join(extractedPath, 'bin');
                
                if (fs.existsSync(binPath)) {
                    const targetBinPath = path.join(ffmpegDir, 'bin');
                    if (!fs.existsSync(targetBinPath)) {
                        fs.mkdirSync(targetBinPath, { recursive: true });
                    }
                    
                    const binFiles = fs.readdirSync(binPath);
                    binFiles.forEach(file => {
                        const sourcePath = path.join(binPath, file);
                        const targetPath = path.join(targetBinPath, file);
                        fs.copyFileSync(sourcePath, targetPath);
                    });
                }
            }
            
            fs.unlink(zipPath, () => {});
            if (extractedFolders.length > 0) {
                const extractedPath = path.join(ffmpegDir, extractedFolders[0]);
                fs.rmSync(extractedPath, { recursive: true, force: true });
            }
            
            console.log('✅ FFmpeg extracted successfully');
            resolve();
        });
    });
};

const checkFFmpeg = async () => {
    try {
        if (fs.existsSync(ffmpegPath)) {
            console.log('✅ FFmpeg found locally');
            return ffmpegPath;
        }
        
        await execPromise('ffmpeg -version');
        console.log('✅ FFmpeg found in system PATH');
        return 'ffmpeg';
    } catch (error) {
        console.log('❌ FFmpeg not found, downloading...');
        await downloadFFmpeg();
        return ffmpegPath;
    }
};

const parseQuality = (format) => {
    let qualityLabel = format.format_note || 'unknown';
    let height = format.height || 0;
    
    if (!qualityLabel && height) {
        if (height >= 2160) qualityLabel = '4K (2160p)';
        else if (height >= 1440) qualityLabel = '2K (1440p)';
        else if (height >= 1080) qualityLabel = '1080p';
        else if (height >= 720) qualityLabel = '720p';
        else if (height >= 480) qualityLabel = '480p';
        else if (height >= 360) qualityLabel = '360p';
        else if (height >= 240) qualityLabel = '240p';
        else qualityLabel = '144p';
    }
    
    if (!format.vcodec || format.vcodec === 'none') {
        if (format.acodec !== 'none') {
            const bitrate = format.abr || 128;
            qualityLabel = `Audio ${bitrate}kbps`;
        }
    }
    
    return qualityLabel || 'Unknown';
};

const getQualityOrder = (quality) => {
    const order = {
        '4K': 100, '4K (2160p)': 100, '2160p': 100,
        '2K': 90, '2K (1440p)': 90, '1440p': 90,
        '1080p': 80, '1080p60': 85,
        '720p': 70, '720p60': 75,
        '480p': 60, '360p': 50, '240p': 40, '144p': 30
    };
    
    if (quality.includes('Audio')) {
        const bitrate = parseInt(quality.match(/\d+/)?.[0] || '0');
        return 20 + (bitrate / 10);
    }
    
    return order[quality] || 0;
};

const enhancedFormatProcessing = (formats) => {
    console.log(`Processing ${formats.length} total formats...`);
    
    const processedFormats = formats
        .filter(format => {
            const hasVideoAudio = format.vcodec !== 'none' && format.acodec !== 'none';
            const isHighQualityVideoOnly = format.vcodec !== 'none' && format.acodec === 'none' && format.height >= 720;
            const isAudioOnly = (format.vcodec === 'none' || !format.vcodec) && format.acodec !== 'none';
            
            return hasVideoAudio || isHighQualityVideoOnly || isAudioOnly;
        })
        .map(format => {
            const quality = parseQuality(format);
            const fileSize = format.filesize ? parseInt(format.filesize) : null;
            const isAudio = (format.vcodec === 'none' || !format.vcodec) && format.acodec !== 'none';
            
            return {
                itag: format.format_id,
                quality: quality,
                container: isAudio ? (format.ext === 'webm' ? 'm4a' : format.ext || 'mp3') : format.ext || 'mp4',
                filesize: fileSize,
                filesizeText: fileSize ? formatFileSize(fileSize) : 'Size unknown',
                type: format.vcodec !== 'none' && format.acodec !== 'none' ? 'video+audio' : 
                      format.vcodec !== 'none' ? 'video-only' : 'audio-only',
                codecs: format.codec || 'unknown',
                bitrate: format.tbr ? parseInt(format.tbr * 1000) : 0,
                fps: format.fps || null,
                height: format.height || 0,
                width: format.width || 0,
                audioBitrate: format.abr || null,
                mimeType: isAudio ? 'audio/mp4' : format.mime_type || 'video/mp4',
                hasVideo: format.vcodec !== 'none' && format.vcodec,
                hasAudio: format.acodec !== 'none'
            };
        });

    const uniqueFormats = new Map();
    processedFormats.forEach(format => {
        const key = `${format.quality}-${format.type}`;
        const existing = uniqueFormats.get(key);
        
        if (!existing || 
            (format.filesize && format.filesize > (existing.filesize || 0)) ||
            (format.bitrate > existing.bitrate)) {
            uniqueFormats.set(key, format);
        }
    });

    const finalFormats = Array.from(uniqueFormats.values())
        .sort((a, b) => getQualityOrder(b.quality) - getQualityOrder(a.quality));

    console.log(`✅ Processed to ${finalFormats.length} unique formats`);
    return finalFormats;
};

app.get('/api/health', (req, res) => {
    console.log('💊 Health check requested from:', req.get('origin') || req.get('host') || 'unknown');
    
    const healthData = { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        platform: 'YouTube Only',
        version: '2.4.0-anti-bot',
        message: 'Server is running perfectly with anti-bot protection!',
        cors: 'enabled',
        features: [
            'Anti-Bot Protection', 
            'Enhanced Headers', 
            'Smart Cookies',
            'Auto FFmpeg Download', 
            '4K Support (2160p)', 
            '2K Support (1440p)', 
            '1080p HD', 
            '720p HD',
            'Audio Downloads (MP3/M4A)', 
            'Enhanced Error Handling'
        ],
        dependencies: {
            ffmpeg: fs.existsSync(ffmpegPath) ? 'Available locally' : 'Will auto-download',
            ytdlp: 'Available with anti-bot measures',
            cookies: fs.existsSync(path.join(__dirname, 'cookies.txt')) ? 'Available' : 'Will create'
        },
        uptime: Math.round(process.uptime()),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        },
        connection: {
            port: PORT,
            host: req.get('host'),
            origin: req.get('origin'),
            userAgent: req.get('user-agent')?.substring(0, 50) + '...'
        }
    };
    
    console.log('✅ Health check response sent');
    res.status(200).json(healthData);
});

app.post('/api/video-info', async (req, res) => {
    const startTime = Date.now();
    
    try {
        console.log('📥 Video info request received from:', req.get('origin') || 'unknown');
        
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ 
                error: 'URL is required',
                timestamp: new Date().toISOString()
            });
        }

        if (!validateYouTubeURL(url)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube URL. Please provide a valid YouTube video URL.',
                timestamp: new Date().toISOString()
            });
        }

        // Create cookies file if it doesn't exist
        createCookiesFile();

        console.log('🔍 Fetching video info for:', url);
        
        // Use enhanced command with anti-bot measures
        const command = buildYtDlpCommand(url, { dumpJson: true });
        console.log('🤖 Using anti-bot command:', command.substring(0, 100) + '...');
        
        const { stdout, stderr } = await execPromise(command);
        if (stderr && !stderr.includes('WARNING')) {
            console.warn('yt-dlp stderr:', stderr);
        }
        
        const info = JSON.parse(stdout);
        
        if (!info) {
            throw new Error('Video details not available');
        }
        
        console.log(`📊 Found ${info.formats.length} total formats for: ${info.title}`);
        
        const processedFormats = enhancedFormatProcessing(info.formats);
        
        if (processedFormats.length === 0) {
            throw new Error('No downloadable formats found for this video');
        }

        const responseData = {
            platform: 'YouTube',
            videoId: info.id,
            title: info.title,
            description: info.description?.substring(0, 500) || 'No description available',
            thumbnail: info.thumbnail || `https://img.youtube.com/vi/${info.id}/maxresdefault.jpg`,
            duration: parseInt(info.duration) || 0,
            formattedDuration: formatDuration(parseInt(info.duration)),
            views: parseInt(info.view_count) || 0,
            author: info.uploader || info.channel || 'Unknown',
            uploadDate: info.upload_date || new Date().toISOString(),
            availableQualities: processedFormats,
            totalFormats: info.formats.length,
            processedFormats: processedFormats.length,
            processingTime: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        };

        console.log(`✅ Response ready - ${processedFormats.length} formats in ${Date.now() - startTime}ms`);
        return res.json(responseData);

    } catch (error) {
        console.error('❌ Video info error:', error);
        
        let userFriendlyError = 'Failed to fetch video information';
        let suggestion = 'Please check if the video is available and not age-restricted or private';
        
        if (error.message.includes('Video unavailable')) {
            userFriendlyError = 'Video is unavailable or has been removed';
            suggestion = 'Please check if the video URL is correct and the video is publicly accessible';
        } else if (error.message.includes('age')) {
            userFriendlyError = 'Cannot access age-restricted content';
            suggestion = 'This video requires age verification which is not supported';
        } else if (error.message.includes('private')) {
            userFriendlyError = 'Cannot access private video';
            suggestion = 'This video is private and cannot be downloaded';
        } else if (error.message.includes('Sign in to confirm') || error.message.includes('confirm you are not a robot')) {
            userFriendlyError = 'YouTube bot detection triggered';
            suggestion = 'Server is implementing anti-bot measures. Please try again in a few moments.';
        } else if (error.message.includes('HTTP Error 429')) {
            userFriendlyError = 'Rate limit exceeded';
            suggestion = 'Too many requests. Please wait a few minutes before trying again.';
        }
        
        return res.status(500).json({ 
            error: userFriendlyError,
            details: error.message,
            suggestion: suggestion,
            processingTime: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/download', async (req, res) => {
    const startTime = Date.now();
    
    try {
        console.log('📥 Download request received from:', req.get('origin') || 'unknown');
        
        const { url, itag } = req.body;
        
        if (!url || !itag) {
            return res.status(400).json({ 
                error: 'URL and quality selection (itag) are required' 
            });
        }

        if (!validateYouTubeURL(url)) {
            return res.status(400).json({ 
                error: 'Invalid YouTube URL' 
            });
        }

        const ffmpegCommand = await checkFFmpeg();
        console.log('✅ FFmpeg ready:', ffmpegCommand);

        // Create cookies file if it doesn't exist
        createCookiesFile();

        console.log(`🎬 Starting download - itag: ${itag}, URL: ${url}`);
        
        // Get video info with anti-bot measures
        const infoCommand = buildYtDlpCommand(url, { dumpJson: true });
        const { stdout } = await execPromise(infoCommand);
        const info = JSON.parse(stdout);
        const format = info.formats.find(f => f.format_id === itag);
        
        if (!format) {
            console.error(`❌ Format not found - itag: ${itag}`);
            return res.status(404).json({ 
                error: 'Selected quality not available',
                availableItags: info.formats.map(f => f.format_id).slice(0, 10)
            });
        }

        const title = info.title;
        const quality = parseQuality(format);
        const isAudio = (format.vcodec === 'none' || !format.vcodec) && format.acodec !== 'none';
        
        let extension = 'mp4';
        let mimeType = 'video/mp4';
        
        if (isAudio) {
            extension = 'mp3';
            mimeType = 'audio/mpeg';
            if (format.acodec === 'm4a' || format.ext === 'm4a') {
                extension = 'm4a';
                mimeType = 'audio/mp4';
            }
        } else {
            extension = format.ext || 'mp4';
            mimeType = format.mime_type || 'video/mp4';
        }
        
        const filename = sanitizeFilename(`${title}_${quality}.${extension}`);
        const outputPath = path.join(downloadsDir, filename);
        
        console.log(`⬇️ Downloading: ${filename}`);
        
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', mimeType);
        
        if (format.filesize) {
            res.setHeader('Content-Length', format.filesize);
            console.log(`📦 File size: ${formatFileSize(parseInt(format.filesize))}`);
        }

        // Build download command with anti-bot measures
        let downloadOptions = {
            format: itag,
            ffmpegLocation: ffmpegCommand,
            output: outputPath
        };

        if (isAudio) {
            downloadOptions.extractAudio = true;
            downloadOptions.audioFormat = extension;
        }
        
        const downloadCommand = buildYtDlpCommand(url, downloadOptions);
        console.log('🤖 Using anti-bot download command');
        
        exec(downloadCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Download failed:', error);
                if (!res.headersSent) {
                    let userFriendlyError = 'Download failed';
                    let suggestion = 'Please try again or check the video URL';
                    
                    if (error.message.includes('Video unavailable')) {
                        userFriendlyError = 'Video is unavailable or has been removed';
                        suggestion = 'Please check if the video URL is correct and the video is publicly accessible';
                    } else if (error.message.includes('age')) {
                        userFriendlyError = 'Cannot access age-restricted content';
                        suggestion = 'This video requires age verification which is not supported';
                    } else if (error.message.includes('private')) {
                        userFriendlyError = 'Cannot access private video';
                        suggestion = 'This video is private and cannot be downloaded';
                    } else if (error.message.includes('Sign in to confirm') || error.message.includes('confirm you are not a robot')) {
                        userFriendlyError = 'YouTube bot detection triggered';
                        suggestion = 'Server is implementing anti-bot measures. Please try again in a few moments.';
                    } else if (error.message.includes('HTTP Error 429')) {
                        userFriendlyError = 'Rate limit exceeded';
                        suggestion = 'Too many requests. Please wait a few minutes before trying again.';
                    }
                    
                    return res.status(500).json({ 
                        error: userFriendlyError,
                        details: error.message,
                        suggestion: suggestion,
                        timestamp: new Date().toISOString()
                    });
                }
                return;
            }
            
            console.log(`✅ Download completed: ${filename} in ${Date.now() - startTime}ms`);
            
            if (fs.existsSync(outputPath)) {
                const fileStream = fs.createReadStream(outputPath);
                fileStream.pipe(res);
                
                fileStream.on('end', () => {
                    fs.unlink(outputPath, (err) => {
                        if (err) console.error('Failed to delete file:', err);
                    });
                });
                
                fileStream.on('error', (err) => {
                    console.error('File stream error:', err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'File streaming failed' });
                    }
                });
            } else {
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Downloaded file not found' });
                }
            }
        });

    } catch (error) {
        console.error('❌ Download error:', error);
        if (!res.headersSent) {
            let userFriendlyError = 'Download failed';
            let suggestion = 'Please try again or check the video URL';
            
            if (error.message.includes('Video unavailable')) {
                userFriendlyError = 'Video is unavailable or has been removed';
                suggestion = 'Please check if the video URL is correct and the video is publicly accessible';
            } else if (error.message.includes('age')) {
                userFriendlyError = 'Cannot access age-restricted content';
                suggestion = 'This video requires age verification which is not supported';
            } else if (error.message.includes('private')) {
                userFriendlyError = 'Cannot access private video';
                suggestion = 'This video is private and cannot be downloaded';
            } else if (error.message.includes('Sign in to confirm') || error.message.includes('confirm you are not a robot')) {
                userFriendlyError = 'YouTube bot detection triggered';
                suggestion = 'Server is implementing anti-bot measures. Please try again in a few moments.';
            } else if (error.message.includes('HTTP Error 429')) {
                userFriendlyError = 'Rate limit exceeded';
                suggestion = 'Too many requests. Please wait a few minutes before trying again.';
            }
            
            return res.status(500).json({ 
                error: userFriendlyError,
                details: error.message,
                suggestion: suggestion,
                processingTime: `${Date.now() - startTime}ms`,
                timestamp: new Date().toISOString()
            });
        }
    }
});

app.get('/', (req, res) => {
    res.json({
        message: 'YouTube Downloader API is running perfectly with anti-bot protection!',
        version: '2.4.0-anti-bot',
        status: 'online',
        endpoints: {
            health: '/api/health',
            videoInfo: '/api/video-info',
            download: '/api/download'
        },
        cors: 'enabled for all origins',
        antiBotFeatures: [
            'Enhanced User-Agent',
            'Smart Headers',
            'Cookie Management',
            'Rate Limiting',
            'Request Delays'
        ],
        time: new Date().toISOString()
    });
});

app.use('*', (req, res) => {
    console.log(`❌ 404 - Not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ 
        error: 'Endpoint not found',
        method: req.method,
        path: req.originalUrl,
        availableEndpoints: ['/api/health', '/api/video-info', '/api/download'],
        suggestion: 'Check the API documentation'
    });
});

app.use((error, req, res, next) => {
    console.error('💥 Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log('🚀 Enhanced YouTube Downloader Server Started (ANTI-BOT VERSION)');
    console.log('=' .repeat(60));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`🎯 Platform: YouTube Only`);
    console.log(`💡 Health check: http://localhost:${PORT}/api/health`);
    console.log(`✅ CORS: Enabled for all origins`);
    console.log(`🤖 Anti-Bot: Enhanced headers and cookies`);
    console.log(`📋 Test in browser: http://localhost:${PORT}`);
    console.log('=' .repeat(60));
    
    // Initialize cookies file
    createCookiesFile();
    
    exec('yt-dlp --version', (error, stdout, stderr) => {
        if (error) {
            console.error('❌ yt-dlp not found or failed:', error.message);
            console.error('   Please install: pip install yt-dlp');
            return;
        }
        console.log('✅ yt-dlp is working, version:', stdout.trim());
    });
    
    checkFFmpeg()
        .then(() => console.log('✅ FFmpeg is ready'))
        .catch(() => console.log('⚠️ FFmpeg will be auto-downloaded when needed'));
    
    console.log('\n🔗 Ready to accept connections from React frontend!');
    console.log('🛡️ Anti-bot protection enabled for YouTube downloads');
});