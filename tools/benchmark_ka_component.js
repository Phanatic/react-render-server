#!/usr/bin/env node

'use strict';

/**
 * Render an actual component on the Khan Academy site and profile that.
 *
 * You must have a webapp dev-server already running (this script does
 * not currently work against prod).  You must also have a
 * react-render-server running in 'profile' mode:
 *    npm run profile
 * You must pass in a .fixture.{js,jsx} file; we can only render
 * components that have an associated fixture.  We will figure out
 * everything else needed to render the relevant profile.
 *
 * For now, we can only handle .fixture files without any other
 * dependencies (since we're not running in a webapp context).
 */

/* eslint-disable no-console */

const path = require("path");

const argparse = require("argparse");
const superagent = require("superagent");

const packageInfo = require("../package.json");
const secret = require("../src/secret.js");


/**
 * Given a map from package-name to immediate dependencies, and a
 * package name of interest, update transitiveDeps[pkg] to be list of
 * the transitive dependencies pkg.  It also may update
 * transitiveDeps[otherPkg] of other packages, if it has to figure
 * them out to resolve transitiveDeps[pkg].
 *
 * All entries in transitiveDeps are topologically sorted, so no
 * package in the returned array depends on a package that comes
 * after it in the array.
 */
const updateTransitiveDependencies = function(pkg, depmap, transitiveDeps) {
    if (transitiveDeps[pkg] === 'calculating...') {
        throw new Error(`Cyclic package dependency involving $pkg`);
    } else if (transitiveDeps[pkg]) {
        return;
    }

    transitiveDeps[pkg] = 'calculating...';

    let ourTransitiveDeps = [];
    (depmap[pkg] || []).forEach((dep) => {
        updateTransitiveDependencies(dep, depmap, transitiveDeps);
        ourTransitiveDeps = ourTransitiveDeps.concat(transitiveDeps[dep]);
    });
    ourTransitiveDeps.push(pkg);

    // Let's de-dup this list as we copy ourTransitiveDeps into
    // transitiveDeps[pkg].
    const seen = {};
    transitiveDeps[pkg] = [];
    ourTransitiveDeps.forEach((p) => {
        if (!seen[p]) {
            transitiveDeps[pkg].push(p);
            seen[p] = true;
        }
    });
};


/**
 * Use the package-manifest contents to return (a promise of) a map
 * from package-name to a list of the urls of all dependent packages
 * (i.e. the transitive dependencies).  So if pkgA depends on pkgB
 * depends on pkgC, then map that this function returns has an entry
 *   'pkgA': ['url to fetch pkgC', 'url to fetch pkgB', 'url to fetch pkgA']
 */
const getPackageToDependentUrlsMap = function(gaeHostPort) {
    // We need the transitive dependency map for the package
    // containing our component.  This is a bit annoying for 3
    // reasons:
    // 1) On prod, the file containing the map has a hard-to-guess
    //    filename, so we need to extract it from the homepage;
    // 2) The file containing the map is not json, so we have to
    //    extract out the info we want using regexps;
    // 3) We need to figure out the transitive deps ourselves.
    // We do (1) and (2), at least, here.
    // TODO(csilvers): compute (3) here as well too.
    return requestToPromise(superagent.get(gaeHostPort + '/')).then(res => {
        const re = /['"]([^"']*\/package-manifest[^'"]*)["']/;
        const results = re.exec(res.text);
        if (!results) {
            throw new Error("Can't find package-manifest in homepage");
        }
        let packageManifestUrl = results[1];
        if (packageManifestUrl.indexOf('://') === -1) {
            packageManifestUrl = gaeHostPort + packageManifestUrl;
        }
        return packageManifestUrl;
    }).then((packageManifestUrl) => {
        return requestToPromise(superagent.get(packageManifestUrl));
    }).then((packageManifestResult) => {
        const manifestContents = packageManifestResult.text;
        const dependencyString = manifestContents.replace(
                /^.*"javascript": (\[.*\]), "stylesheets":.*/, '$1');
        const dependencyInfo = JSON.parse(dependencyString);

        // Read the manifest into some useful data structures.
        const pkgToUrl = {};       // for some value of "const"
        const dependencyMap = {};  // direct dependencies, parsed from the file
        dependencyInfo.forEach((packageInfo) => {
            dependencyMap[packageInfo.name] = packageInfo.dependencies;
            pkgToUrl[packageInfo.name] = gaeHostPort + packageInfo.url;
        });

        // For each package, go from direct deps to transitive deps.
        const transitiveDependencyMap = {};
        Object.keys(pkgToUrl).forEach((pkg) => {
            updateTransitiveDependencies(pkg, dependencyMap,
                                         transitiveDependencyMap);
        });

        // Replace each dependent package-name with the package-url instead.
        const retval = {};
        Object.keys(transitiveDependencyMap).forEach((pkg) => {
            retval[pkg] = transitiveDependencyMap[pkg].map(p => pkgToUrl[p]);
        });

        return retval;
    });
};


/**
 * Guess what package a component lives in from its filename.  Usually
 * the filename will have 'foo-package' in it.  That's not a guarantee
 * the component is in foo-package, but it's a good sign...
 * Calls resolve/reject, because that's easiest given how this is used.
 */
const guessPackage = function(componentPath, resolve, reject) {
    const result = /\/([^\/]*)-package\//.exec(componentPath);
    if (result) {
        resolve(result[1] + '.js');
    } else {
        reject(new Error('Could not guess package for ' + componentPath));
    }
};


/**
 * Return the package that a given component lives in.
 * On localhost, we can just ask the system to do this mapping.  But for
 * prod, we don't have access to the necessary information, so we just
 * guess.  TODO(csilvers): if guessing isn't good enough, we could also
 * talk to a local dev-server just for this mapping, and assume it's the
 * same for dev and prod.  But that's a lot of work for minimal gain.
 */
const getPackage = function(componentPath, gaeHostPort) {
    // For known prod servers, we don't even bother trying to talk to
    // them as if they're dev.
    if (gaeHostPort.indexOf('khanacademy.org') > -1 ||
           gaeHostPort.indexOf('appspot.com') > -1) {
        return new Promise((resolve, reject) => {
            guessPackage(componentPath, resolve, reject);
        });
    }
    // First try to talk to /_kake/ -- that will work on localhost.
    // If it fails, assume we're on prod and just guess the package.
    const pathToPackageMapUrl = (
        '/_kake/genfiles/js_path_to_pkgs/en/path_to_packages_prod.json');
    return new Promise((resolve, reject) => {
        superagent.get(gaeHostPort + pathToPackageMapUrl).end((err, res) => {
            if (err) {
                // Presumably we're on prod, let's just guess the package!
                guessPackage(componentPath, resolve, reject);
            } else {
                const pathToPackagesMap = res.body;
                const componentPackage = pathToPackagesMap[componentPath][0];
                resolve(componentPackage);
            }
        });
    });
};


// Convert superagent-style callbacks to promises.
const requestToPromise = function(req, extra) {
    return new Promise((resolve, reject) => {
        req.buffer().end((err, res) => {
            if (err) {
                reject(err);
            } else {
                if (extra) {
                    resolve([res, extra]);
                } else {
                    resolve(res);
                }
            }
        });
    });
};


/**
 * Return profile information about rendering component with fixture.
 *
 * @param {string} componentPath - a path to the component,
 *     relative to webapp's ka-root.
 * @param {string} fixturePath - where the fixture file lives on
 *     the local filesystem.  Should be an absolute path.
 * @param {number} instanceSeed - a (preferably large) integer.
 *     When the props file has multiple instances that could be used
 *     to populate the fixture, we use the instanceSeed to decide which
 *     one to use.  The mapping from seed to instance is arbitrary but
 *     fixed -- using the same seed again will yield the same instance.
 * @param {string} gaeHostPort - actually a protocol-host-port, where
 *     the webapp server is running.
 * @param {string} renderHostPort - actually a protocol-host-port, where
 *      the react-render-server is running.
 * @param {string} packageToDependentUrlsMap - the output of
 *      getPackageToDependentUrlsMap().
 */
const render = function(componentPath, fixturePath, instanceSeed,
                        gaeHostPort, renderHostPort,
                        packageToDependentUrlsMap) {
    let props;
    const relativeFixturePath = path.relative(__dirname, fixturePath);
    try {
        const allProps = require(relativeFixturePath).instances;
        props = allProps[instanceSeed % allProps.length];
    } catch (err) {
        console.log(`Skipping ${fixturePath}: ${err}`);
        // Maybe semantically this is a reject(), but resolve() means
        // we don't have to capture reject()'s below.
        return Promise.resolve(err);
    }

    return getPackage(componentPath, gaeHostPort).then((componentPackage) => {
        const depPackageUrls = packageToDependentUrlsMap[componentPackage];

        const reqBody = {
            secret: secret.get(),
            urls: depPackageUrls,
            path: "./" + componentPath,
            props: props,
        };

        // The `?path=` query param we add onto the end is completely ignored
        // by the server -- we add it here in order to make reading request
        // logs easier.
        const url = renderHostPort + "/render?path=" + componentPath;

        return requestToPromise(
            superagent.post(url).send(reqBody),
            +new Date      // "extra" param: time when the request is sent off
        );
    }).then(resAndStartTime => {
        const elapsedTime = +new Date - resAndStartTime[1];
        console.log(`${componentPath}: ${resAndStartTime[0].text.length} ` +
                    `${elapsedTime}ms`);
    }).catch(err => {
        // If it's an http error, print the status code rather than name,
        // and the error text if the body is json.
        if (err.response && err.response.status && err.response.text) {
            console.log(`${componentPath}: ` +
                        `${err.response.text} (${err.response.status})`);
        } else {
            console.log(`${componentPath}: ${err})`);
        }
    });
};

const renderQueue = [];
let inflightRequestCount = 0;

const renderFromQueue = () => {
    if (renderQueue.length > 0) {
        inflightRequestCount++;
        render.apply(null, renderQueue.shift()).then(() => { // @Nolint(apply)
            inflightRequestCount--;
            renderFromQueue();
        });
    }
};


/**
 * Call render(), but only allow maxConcurrentRequests in flight at a time to
 * avoid making thousands of concurrent connections.
 *
 * When we're at the limit for max concurrent requests, we'll queue the render
 * call for later.
 */
const throttledRender = function(componentPath, fixturePath, instanceSeed,
                                 gaeHostPort, renderHostPort,
                                 packageToDependentUrlsMap,
                                 maxConcurrentRequests) {
    renderQueue.push([
        componentPath,
        fixturePath,
        instanceSeed,
        gaeHostPort,
        renderHostPort,
        packageToDependentUrlsMap,
    ]);

    if (inflightRequestCount < maxConcurrentRequests) {
        renderFromQueue();
    }
};


const main = function(parseArgs) {
    let gaeHostPort;
    let rrsHostPort;

    if (parseArgs.dev || parseArgs.dev_webapp) {
        gaeHostPort = "http://localhost:8080";
    } else {
        gaeHostPort = "https://www.khanacademy.org";
    }

    if (parseArgs.dev || parseArgs.dev_render) {
        rrsHostPort = "http://localhost:8060";
    } else {
        rrsHostPort = "https://react-render-dot-khan-academy.appspot.com";
    }

    getPackageToDependentUrlsMap(gaeHostPort).then((pkgToDepUrlsMap) => {
        const fixtureToComponent = {};

        // To get the path to the component, we just remove the trailing
        // .fixture.js, and the leading ka-root prefix.  For now, we
        // assume that the fixture is at <ka_root>/javascript/...
        // TODO(csilvers): figure out ka-root better.
        for (let i = 0; i < parseArgs.num_trials_per_component; i++) {
            parseArgs.fixtures.forEach((fixturePath) => {
                const fixtureAbspath = path.resolve(fixturePath);
                try {
                    if (!fixtureToComponent[fixtureAbspath]) {
                        const re = /(javascript\/.*)\.fixture\./;
                        const result = re.exec(fixtureAbspath);
                        if (result) {
                            fixtureToComponent[fixtureAbspath] = result[1];
                        } else {
                            throw new Error('cannot infer component from ' +
                                            fixtureAbspath);
                        }
                    } else if (fixtureToComponent[fixtureAbspath] === 'error') {
                        // We've already logged that this fixture is broken,
                        // so we can just skip it.
                        return;
                    }
                    // Let's do the work!
                    const componentPath = fixtureToComponent[fixtureAbspath];
                    throttledRender(componentPath, fixtureAbspath, i,
                                    gaeHostPort, rrsHostPort,
                                    pkgToDepUrlsMap,
                                    parseArgs.max_concurrent_requests);
                } catch (err) {
                    console.log(`Skipping ${fixturePath}: ${err}`);
                    fixtureToComponent[fixtureAbspath] = 'error';
                }
            });
        }
    });
};


process.on('unhandledRejection', (reason, p) => {
    console.log("Unhandled Rejection at: Promise ", p,
                " reason: ", reason.stack);
});

const parser = new argparse.ArgumentParser({
    version: packageInfo.version,
    addHelp: true,
    description: "A load tester/benchmarker for the react-render-server",
});
parser.addArgument(['fixtures'],
                   {nargs: '*',
                    defaultValue: ["../webapp/javascript/content-library-package/components/concept-thumbnail.jsx.fixture.js"],  // @Nolint(long line)
                    help: "List of fixture files on the local filesystem"});
parser.addArgument(['--dev'],
                   {action: 'storeTrue',
                    help: "Connect to local gae and render-server"});
parser.addArgument(['--dev-webapp'],
                   {action: 'storeTrue',
                    help: "Use local webapp (on localhost:8080)"});
parser.addArgument(['--dev-render'],
                   {action: 'storeTrue',
                    help: "Use local render-server (on localhost:8060)"});
parser.addArgument(['-n', '--num-trials-per-component'],
                   {type: 'int', defaultValue: 1,
                    help: ("How many times we render a given component " +
                           "with a given fixture file (for load testing)")});
parser.addArgument(['-r', '--max-concurrent-requests'],
                   {type: 'int', defaultValue: 500,
                    help: ("We have at most this many requests in flight " +
                           "at once")});

main(parser.parseArgs());


/* For manual testing, here's a curl command you can send to a server directly:

curl -H "Content-type: application/json" -d '{"secret":"'`cat ../secret`'", "urls":["https://www.khanacademy.org/genfiles/javascript/en/corelibs-package-31375e.js","https://www.khanacademy.org/genfiles/javascript/en/corelibs-legacy-package-fbfab0.js","https://www.khanacademy.org/genfiles/javascript/en/shared-package-1e468a.js","https://www.khanacademy.org/genfiles/javascript/en/shared-styles-package-32d405.js","https://www.khanacademy.org/genfiles/javascript/en/hover-card-package-de8d87.js","https://www.khanacademy.org/genfiles/javascript/en/react-package-9b7fb9.js","https://www.khanacademy.org/genfiles/javascript/en/react-components-package-a7e18c.js","https://www.khanacademy.org/genfiles/javascript/en/flux-package-838d8f.js","https://www.khanacademy.org/genfiles/javascript/en/tasks-package-43bf44.js","https://www.khanacademy.org/genfiles/javascript/en/tutorial-package-8e5302.js","https://www.khanacademy.org/genfiles/javascript/en/video-package-9b200b.js","https://www.khanacademy.org/genfiles/javascript/en/content-library-package-9ac69b.js"],"path":"./javascript/content-library-package/components/concept-thumbnail.jsx","props":{"domain":"math","kind":"concept","progressData":{"skillsCompleted":3,"skillsTotal":32},"url":"/images/topic-icons-large/linear_equations.png"}}' 127.0.0.1:8080/render
*/
