import { Config } from '@remotion/cli/config';
import path from 'path';

// Remotion CLI loads this config from the project root, so `process.cwd()`
// resolves to `ikenga-desktop/`.
const PROJECT_ROOT = process.cwd();

// Static assets live under public/video/ so they don't collide with PA's
// existing public/ chrome (favicons, etc.). Remotion will resolve every
// staticFile() against this directory at bundle and render time.
Config.setPublicDir('./public/video');

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setConcurrency(4);

// `@/* → src/*` alias — must match PA's tsconfig paths so ported compositions
// (which import via @/video/lib/..., @/video/motion, etc.) resolve at render
// time inside Remotion's webpack bundle.
Config.overrideWebpackConfig((cfg) => ({
	...cfg,
	resolve: {
		...cfg.resolve,
		alias: {
			...(cfg.resolve?.alias ?? {}),
			'@': path.resolve(PROJECT_ROOT, 'src'),
		},
	},
}));
