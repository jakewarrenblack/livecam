const SpawnSync = require( 'child_process' ).spawnSync;
const Spawn = require( 'child_process' ).spawn;
const Assert = require( 'assert' );
const Path = require( 'path' );
const FS = require( 'fs' );
const Net = require( 'net' );
const Http = require( 'http' );
const Dicer = require( 'dicer' );
const SocketIO = require( 'socket.io' );

/*!
 * @class GstLaunch
 * @brief Class that encapsulates "gst-launch" executable.
 * @note Refer to README.md to see how to install GStreamer
 */

class GstLaunch {
    constructor( ) {
        this.gst_launch_executable = 'gst-launch-1.0';
        this.gst_launch_versionarg = '--version';
    }

    /**
     * @fn getPath
     * @brief Returns path to gst-launch or undefined on error
     */
    getPath() {
        let detected_path = undefined;

        // Look for GStreamer on PATH
        const path_dirs = process.env.PATH.split( ':' );
        for( let index = 0; index < path_dirs.length; ++index ) {
            try {
                let base = Path.normalize( path_dirs[ index ] );
                let bin = Path.join(
                    base,
                    this.gst_launch_executable );
                FS.accessSync( bin, FS.F_OK );
                detected_path = bin;
            } catch( e ) { /* no-op */
            }
        }

        return detected_path;
    }

    /**
     * @fn getVersion
     * @brief Returns version string of GStreamer on this machine by
     * invoking the gst-launch executable or 'undefined' on failure.
     */
    getVersion( ) {
        let version_str = undefined;
        try {
            let gst_launch_path = this.getPath();
            Assert.ok( typeof( gst_launch_path ), 'string' );

            let output = SpawnSync(
                gst_launch_path, [ this.gst_launch_versionarg ], {
                    'timeout': 1000
                } ).stdout;

            if( output && output.toString().includes( 'GStreamer' ) ) {
                version_str = output
                    .toString()
                    .match( /GStreamer\s+.+/g )[ 0 ]
                    .replace( /GStreamer\s+/, '' );
            }
        } catch( ex ) {
            version_str = undefined;
        }

        return version_str;
    }

    /*!
     * @fn isAvailable
     * @brief Answers true if gst-launch executable is available
     */
    isAvailable( ) {
        return this.getVersion() !== undefined;
    }

    /*!
     * @fn spawnPipeline
     * @brief Spawns a GStreamer pipeline using gst-launch
     * @return A Node <child-process> of the launched pipeline
     * @see To construct a correct pipeline arg, consult the link below:
     * https://gstreamer.freedesktop.org/data/doc/gstreamer/head/manual/html/chapter-programs.html
     * @usage spawnPipeline('videotestsrc ! autovideosink')
     */
    spawnPipeline( pipeline ) {
        Assert.ok( typeof( pipeline ), 'string' );
        Assert.ok( this.isAvailable(), "gst-launch is not available." );

        let gst_launch_path = this.getPath();
        Assert.ok( typeof( gst_launch_path ), 'string' );

        return Spawn( gst_launch_path, pipeline.split( ' ' ) );
    }
}

/*!
 * @class GstLiveCamServer
 * @brief Encapsulates a GStreamer pipeline to broadcast default webcam.
 */
class GstLiveCamServer {
    constructor( config ) {
        config = config || {};
        Assert.ok( typeof( config ), 'object' );

        this.fake = config.fake || false;
        this.width = config.width || 800;
        this.height = config.height || 600;
        this.framerate = config.framerate || 30;
        this.grayscale = config.grayscale || false;
        this.deviceIndex = config.deviceIndex || -1;

        Assert.ok( typeof( this.fake ), 'boolean' );
        Assert.ok( typeof( this.width ), 'number' );
        Assert.ok( typeof( this.height ), 'number' );
        Assert.ok( typeof( this.framerate ), 'number' );
        Assert.ok( typeof( this.grayscale ), 'boolean' );

        this.gst_multipart_boundary = '--videoboundary';
        this.gst_video_src = '';

        if( !this.fake ) {
            this.gst_video_src = 'v4l2src ! decodebin';
        } else {
            this.gst_video_src = 'videotestsrc';
        }

        if( this.width > 0 || this.height > 0 ) {
            this.gst_video_src += ' ! videoscale ! video/x-raw,width=' + parseInt( this.width ) + ',height=' + parseInt( this.height );
        }

        if( this.framerate > 0 ) {
            this.gst_video_src += ' ! videorate ! video/x-raw,framerate=' + parseInt( this.framerate ) + '/1';
        }

        if( this.grayscale ) {
            this.gst_video_src += ' ! videobalance saturation=0.0 ! videoconvert';
        }
    }

    /*!
    * @fn start
    * @brief Starts a GStreamer pipeline that broadcasts the default
    * webcam over the given TCP address and port.
    * @return A Node <child-process> of the launched pipeline
    */
    start( tcp_addr, tcp_port ) {
        Assert.ok( typeof( tcp_addr ), 'string' );
        Assert.ok( typeof( tcp_port ), 'number' );

        const cam_pipeline = this.gst_video_src + ' ! jpegenc ! multipartmux  boundary="' +
            this.gst_multipart_boundary + '" ! tcpserversink host=' + tcp_addr + ' port=' + tcp_port;

        let gst_launch = new GstLaunch();

        if( gst_launch.isAvailable() ) {
            console.log( 'GstLaunch found: ' + gst_launch.getPath() );
            console.log( 'GStreamer version: ' + gst_launch.getVersion() );
            console.log( 'GStreamer pipeline: ' + cam_pipeline );

            return gst_launch.spawnPipeline( cam_pipeline );
        } else {
            throw new Error( 'GstLaunch not found.' );
        }
    }
}

/*!
 * @class SocketCamWrapper
 * @brief A wrapper that re-broadcasts GStreamer's webcam TCP packets in
 * Socket.IO events. This way browsers can fetch and understand webcam
 * video frames.
 * @credit http://stackoverflow.com/a/23605892/388751
 */
class SocketCamWrapper {
    constructor( gst_tcp_addr, gst_tcp_port, broadcast_tcp_addr, broadcast_tcp_port ) {
        this.gst_multipart_boundary = '--videoboundary';
        this.lastImage = '';
    }

    getLastImage( ) {
        return this.lastImage;
    }

    /*!
    * @fn wrap
    * @brief wraps a TCP server previously started by GstLiveCamServer.
    */
    wrap( gst_tcp_addr, gst_tcp_port, broadcast_tcp_addr, broadcast_tcp_port ) {
        Assert.ok( typeof( gst_tcp_addr ), 'string' );
        Assert.ok( typeof( gst_tcp_port ), 'number' );
        Assert.ok( typeof( broadcast_tcp_addr ), 'string' );
        Assert.ok( typeof( broadcast_tcp_port ), 'number' );

        this.socket = Net.Socket();

        this.socket.connect( gst_tcp_port, gst_tcp_addr, () => {
            this.io = SocketIO.listen(
                Http.createServer()
                    .listen( broadcast_tcp_port, broadcast_tcp_addr ) );

            this.dicer = new Dicer( {
                boundary: this.gst_multipart_boundary
            } );

            this.dicer.on( 'part', ( part ) => {
                let frameEncoded = '';
                part.setEncoding( 'base64' );

                part.on( 'data', ( data ) => {
                    frameEncoded += data;
                } );
                part.on( 'end', () => {
                    io.sockets.emit( 'image', frameEncoded );
                    this.lastImage = frameEncoded;
                } );
            } );

            this.dicer.on( 'finish', () => {
                console.log( 'Dicer finished: ' + broadcast_tcp_addr + ':' + broadcast_tcp_port );
            } );

            this.socket.on( 'close', () => {
                console.log( 'Socket closed: ' + broadcast_tcp_addr + ':' + broadcast_tcp_port );
            } );

            this.socket.pipe( this.dicer );
        } );
    };
}
//
// /*!
//  * @class LiveCamUI
//  * @brief serves a minimal UI to view the webcam broadcast.
//  */
// function LiveCamUI() {
//
//     const Http = require( 'http' );
//     const Assert = require( 'assert' );
//     const template = ( function() {
//         /*
//             <!doctype html>
//             <html lang="en">
//                 <head>
//                     <meta charset="utf-8">
//                     <title>livecam UI</title>
//                     <script type="text/javascript" src="https://cdn.socket.io/socket.io-1.4.5.js"></script>
//                     <script type="text/javascript" src="https://code.jquery.com/jquery-1.12.4.min.js"></script>
//                     <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/meyer-reset/2.0/reset.min.css">
//                     <style type="text/css">html,body,.feed,.feed img{width:100%;height:100%;overflow:hidden;}</style>
//                 </head>
//                 <body>
//                     <div class="feed"><img id="video" src="" /></div>
//                     <script>
//                         var webcam_addr = "@WEBCAM_ADDR@";
//                         var webcam_port = "@WEBCAM_PORT@";
//                         var webcam_host = $(".feed img");
//                         var socket = io.connect('http://' + webcam_addr + ':' + webcam_port);
//
//                         socket.on('image', function (data) {
//                             webcam_host.attr("src", "data:image/jpeg;base64," + data );
//                         });
//                     </script>
//                 </body>
//             </html>
//             */
//     } ).toString().match( /\/\*\s*([\s\S]*?)\s*\*\//m )[ 1 ];
//
//     var server = undefined;
//
//     var serve = function( ui_addr, ui_port, webcam_addr, webcam_port ) {
//         Assert.ok( typeof( ui_addr ), 'object' );
//         Assert.ok( typeof( ui_port ), 'number' );
//         Assert.ok( typeof( webcam_addr ), 'object' );
//         Assert.ok( typeof( webcam_port ), 'number' );
//
//         close();
//         server = Http.createServer( function( request, response ) {
//             response.writeHead( 200, {
//                 "Content-Type": "text/html"
//             } );
//             response.write( template
//                 .replace( '@WEBCAM_ADDR@', webcam_addr )
//                 .replace( '@WEBCAM_PORT@', webcam_port ) );
//             response.end();
//         } );
//         server.listen( ui_port, ui_addr );
//
//         console.log( 'Open http://' + ui_addr + ':' + ui_port + '/ in your browser!' );
//     }
//
//     var close = function() {
//         if( server ) {
//             server.close();
//             server = undefined;
//         }
//     }
//
//     return {
//         'serve': serve,
//         'close': close
//     }
//
// }

/*!
 * @class LiveCam
 * @brief starts a livecam server at given config params
 * @note config can have the following options:
 * config.gst_tcp_addr --> where GStreamer TCP socket host is
 *    [optional] [default: 127.0.0.1]
 * config.gst_tcp_port --> where GStreamer TCP socket port is
 *    [optional] [default: 10000]
 * config.ui_addr --> where minimal UI host is
 *    [optional] [default: 127.0.0.1]
 * config.ui_port --> where minimal UI port is
 *    [optional] [default: 11000]
 * config.broadcast_addr --> where Socket IO host is (browser-visible)
 *    [optional] [default: 127.0.0.1]
 * config.broadcast_port --> where Socket IO port is (browser-visible)
 *    [optional] [default: 12000]
 * config.start --> event emitted when streaming is started
 *    [optional] [default: null]
 */
class LiveCam {
    constructor( config ) {
        config = config || {};
        Assert.ok( typeof( config ), 'object' );

        this.gst_tcp_addr = config.gst_addr || "127.0.0.1";
        this.gst_tcp_port = config.gst_port || 10000;
        this.ui_addr = config.ui_addr || "127.0.0.1";
        this.ui_port = config.ui_port || 11000;
        this.broadcast_addr = config.broadcast_addr || "127.0.0.1";
        this.broadcast_port = config.broadcast_port || 12000;
        this.start = config.start;
        this.webcam = config.webcam || {};

        this.gst_cam_wrap = null;
        this.gst_cam_server = null;
        this.gst_cam_process = null;

        if( this.start ) Assert.ok( typeof( this.start ), 'function' );
        if( this.broadcast_port ) Assert.ok( typeof( this.broadcast_port ), 'number' );
        if( this.broadcast_addr ) Assert.ok( typeof( this.broadcast_addr ), 'string' );
        if( this.ui_port ) Assert.ok( typeof( this.ui_port ), 'number' );
        if( this.ui_addr ) Assert.ok( typeof( this.ui_addr ), 'string' );
        if( this.gst_tcp_port ) Assert.ok( typeof( this.gst_tcp_port ), 'number' );
        if( this.gst_tcp_addr ) Assert.ok( typeof( this.gst_tcp_addr ), 'string' );
        if( this.webcam ) Assert.ok( typeof( this.webcam ), 'object' );

        if( !( new GstLaunch() ).isAvailable() ) {
            console.log( "==================================================" );
            console.log( "Unable to locate gst-launch executable." );
            console.log( "Look at https://github.com/sepehr-laal/livecam" );
            console.log( "You are most likely missing the GStreamer runtime." );
            console.log( "==================================================" );

            throw new Error( 'Unable to broadcast.' );
        }

        console.log( "LiveCam parameters:", {
            'broadcast_addr': this.broadcast_addr,
            'broadcast_port': this.broadcast_port,
            'ui_addr': this.ui_addr,
            'ui_port': this.ui_port,
            'gst_tcp_addr': this.gst_tcp_addr,
            'gst_tcp_port': this.gst_tcp_port
        } );
    }

    broadcast( ) {
        // var gst_cam_ui = new LiveCamUI();
        this.gst_cam_wrap = new SocketCamWrapper();
        this.gst_cam_server = new GstLiveCamServer( this.webcam );
        this.gst_cam_process = this.gst_cam_server.start( this.gst_tcp_addr, this.gst_tcp_port );

        this.gst_cam_process.stdout.on( 'data', ( data ) => {
            // console.log( data.toString() );
            // This catches GStreamer when pipeline goes into PLAYING state
            if( data.toString().includes( 'Setting pipeline to PLAYING' ) > 0 ) {
                this.gst_cam_wrap.wrap( this.gst_tcp_addr, this.gst_tcp_port, this.broadcast_addr, this.broadcast_port );
                // gst_cam_ui.serve( ui_addr, ui_port, broadcast_addr, broadcast_port );
                // gst_cam_ui.close();

                if( start )
                    start();
            }
        } );

        this.gst_cam_process.stderr.on( 'data', ( data ) => {
            // console.log( data.toString() );
            // gst_cam_ui.close();
        } );
        this.gst_cam_process.on( 'error', ( err ) => {
            console.log( "Webcam server error: " + err );
            // gst_cam_ui.close();
        } );
        this.gst_cam_process.on( 'exit', ( code ) => {
            console.log( "Webcam server exited: " + code );
            // gst_cam_ui.close();
        } );
    }

    getLastImage( ) {
        if( !this.gst_cam_wrap )
            return '';

        return this.gst_cam_wrap.getLastImage( );
    }
}

module.exports = LiveCam;
