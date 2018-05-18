$(function() {
    var Navigation = function(options) {
        _.defaults(options || (options = {}), {
            storagePrefixFormat : "BNC_{0}",
            useLocalStorage : true,
            maxPageEntries : 30 // the maximum page entries that are allowed - will cut the tail once it gets larger than maximum
        });

        this.COOKIE_PREFIX_FORMAT = options.storagePrefixFormat;

        this.d = $.Deferred();
        this.breadcrumbs = new Backbone.Collection();
        this.routers = {};
        this.tree = {};
        this.maxPageEntries = options.maxPageEntries;
        this.storageApi = options.useLocalStorage ? common.storage.LocalStorage : common.storage.CookieStorage;

        var that = this;

        this._buildBreadcrumbsFromCookies = function () {
            var storageIndex = 0;
            var storageKey = this.COOKIE_PREFIX_FORMAT.format(storageIndex);
            var hasPage = this.storageApi.hasItem(storageKey);

            while(hasPage) {
                var page = this.storageApi.getItem(storageKey);
                var pageModel = new Backbone.Model(page);

                this.breadcrumbs.add(pageModel);

                // get the next cookie index
                storageIndex++;
                storageKey = this.COOKIE_PREFIX_FORMAT.format(storageIndex);
                hasPage = this.storageApi.hasItem(storageKey);
            }
        };

        this._checkBackNavigationFromBrowser = function () {
            var serverPageUuid = application.getServerData("serverPageUuid");
            var currentPageUrl = application.getPageContextPath() + window.location.hash;

            // starting from the end - cutting the tail
            for (var i = this.breadcrumbs.size() - 1; i >= 0; i--) {
                var pageEntry = this.breadcrumbs.at(i);
                var pageEntryUrl = pageEntry.get('url');
                var pageEntryServerUuid = pageEntry.get('serverPageUuid');

                // searching all page entries, if one of them has the same server uuid
                if (pageEntry.has('url') && currentPageUrl.indexOf(pageEntryUrl) !== -1) {
                    var pageEntryHasHash = pageEntryUrl.indexOf("#!") !== -1;

                    if(pageEntryHasHash || pageEntryServerUuid == serverPageUuid) {
                        // the user clicked the back button
                        that.routeToPageEntry(pageEntry, true, true);
                        break; // do not route any page anymore...
                    }
                }
            }
        };

        this._syncServerPageUuidWithDuplicatesOfPageEntry = function (pageEntry) {
            var serverPageUuid = pageEntry.get("serverPageUuid");

            for (var i = 0; i < this.breadcrumbs.size(); i++) {
                var breadPageEntry = this.breadcrumbs.at(i);
                if(breadPageEntry.get("url") == pageEntry.get("url")) {
                    breadPageEntry.set('serverPageUuid', serverPageUuid);

                    // Update the page's cookie
                    var cookieKey = that.COOKIE_PREFIX_FORMAT.format(breadPageEntry.get("index"));
                    this.storageApi.setItem(cookieKey, breadPageEntry.toJSON());
                }
            }
        };

        // build the breadcrumbs from cookies on initialize
        this._buildBreadcrumbsFromCookies();

        this.getAllRouters = function() {
            return _.values(that.routers);
        };

        this.appendRouter = function(router) {
            if (typeof(router.navigation) != "undefined") {
                _.extend(that.tree, router.navigation.pages);
                that.routers[router.navigation.prefix] = router;
            }
        };

        this.mapRouters = function() {
            for (var i in that.routers) {
                that.routers[i].bind('route', function (route, args) {
                    var router = this;
                    //that.breadcrumbs.reset();
                    var url = that._getRouteUrl(router, route);
                    var mappedArgs = that._getMappedArgs(args, url);
                    that._mapNavigation(router.navigation.prefix + '.' + route, mappedArgs);

                    that.getBreadcrumbs();
                });
            }
        };

        this._getMappedArgs = function(args, link) {
            var route = Backbone.Router.prototype._routeToRegExp(link);
            var argNames = Backbone.Router.prototype._extractParameters(route, link);

            var namedArgs = {};
            for (var i in argNames) {
                var argName = argNames[i];

                var propertyName = argName.replace(":", "");
                namedArgs[argName] = args[propertyName];
            }
            return namedArgs;
        };

        this._getMappedUrl = function(url, mappedArgs) {
            for (var argName in mappedArgs) {
                var arg = mappedArgs[argName];
                url = url.replace(argName, arg);
            }
            return url;
        };

        this._mapNavigation = function(route, mappedArgs) {
            if (!that.tree[route]) {
                return;
            }

            var isFunction = typeof(that.tree[route].template) == "function";
            var newEntryOnArgChange = that.tree[route].newEntryOnArgChange;

            var routeParts = route.split('.');
            var router = that.routers[routeParts[0]];
            var shortRoute = routeParts[1];

            var lastPage = this.breadcrumbs.last();
            var url = this._getMappedUrl(this._getRouteUrl(router, shortRoute), mappedArgs);
            var serverData = application.getServerData("serverPageUuid");

            var page = new Backbone.Model({
                url: url,
                text: isFunction ? that.tree[route].template(mappedArgs): that.tree[route].template,
                mappedArgs: mappedArgs,
                isResolved: false,
                serverPageUuid : serverData,
                route : route,
                index : that.breadcrumbs.size(),
                data : {}, // custom page data
                backNavigation : that.isBackNavigation()
            });

            var isDeferred = (typeof(page.get('text') == 'Object') && page.get('text').resolve);
            if (isDeferred) {
                page.get('text').done(function(template){
                    page.set({'text': template, 'isResolved': true});
                    that.checkBreadcrumbs();
                });
            } else {
                page.set('isResolved', true);
            }

            var currentPageServerUuid = page.get("serverPageUuid");
            var lastPageServerUuid = lastPage ? lastPage.get("serverPageUuid") : null;

            // last page was the same as current page AND current page is not "sub" module AND last page is sub module - doing back..
            if(lastPage && page.get("url").indexOf("#!") === -1 && lastPage.get("url").indexOf("#!") !== -1
                && currentPageServerUuid == lastPageServerUuid) {

                that.back();
            } else {
                this._syncServerPageUuidWithDuplicatesOfPageEntry(page);

                // additional check for entries where a specific attribute causes an entry
                // not to replace it-self, and create a new one (only if changed)
                var entryArgValueChanged = false;
                if (lastPage && newEntryOnArgChange) {
                    var entryArgKeyCheck = ":{0}".format(newEntryOnArgChange);

                    var pageArgValue = page.get("mappedArgs")[entryArgKeyCheck];
                    var lastPageArgValue = lastPage.get("mappedArgs")[entryArgKeyCheck];

                    entryArgValueChanged = pageArgValue != lastPageArgValue;
                }

                // if page's route is the same as lastPage, replace it
                if(lastPage && lastPage.get("route") == page.get("route") && !entryArgValueChanged) {
                    this.replacePageEntry(lastPage, page, true);
                } else { // add page to cookies and breadcrumbs list
                    that.addPageEntry(page);

                    // check the tail if it needs to be cut
                    that.checkBreadcrumbsTail();
                }
            }
        };

        this._getRouteUrl = function(router, route) {
            for (var url in router.routes) {
                if (route == router.routes[url]) {
                    return url;
                }
            }
        };

        this.getBreadcrumbs = function() {
            this.checkBreadcrumbs();
            return this.d;
        };

        this.isAllPagesResolved = function () {
            for (var i = 0; i < this.breadcrumbs.size(); i++) {
                if (!this.breadcrumbs.at(i).get('isResolved')) {
                    return false;
                }
            }
            return true;
        };

        this.checkBreadcrumbs = function() {
            if (this.isAllPagesResolved() && this.breadcrumbs.size() > 0) {
                this.d.resolve(this.breadcrumbs);
            }
        };

        this.addPageEntry = function (page) {
            var cookieKey = that.COOKIE_PREFIX_FORMAT.format(page.get("index"));
            var value = _.omit(page.toJSON(), "backNavigation"); // not saving the backNavigation internal flag
            this.storageApi.setItem(cookieKey, value);

            that.breadcrumbs.add(page);
        };

        this.removePageEntry = function (page, options) {
            var index = page.get("index");

            var cookieKey = that.COOKIE_PREFIX_FORMAT.format(index);
            this.storageApi.removeItem(cookieKey);

            that.breadcrumbs.remove(page, options);
        };

        this.removeAll = function (options) {
            var pagesToRemove = [];

            for(var index = 0; index < this.breadcrumbs.size(); index++) {
                var pageToRemove = this.breadcrumbs.models[index];
                pagesToRemove.push(pageToRemove);
            }
            that.removePageEntries(pagesToRemove, options);
        };

        this.removePageEntries = function (pagesToRemove, options) {
            for (var i = 0; i < pagesToRemove.length; i++) {
                var pageToRemove = pagesToRemove[i];
                that.removePageEntry(pageToRemove, options);
            }
        };

        this.replacePageEntry = function (oldPage, newPage, copyPageData) {
            var oldIndex = oldPage.get("index");
            var oldData = oldPage.get("data");

            newPage.set("index", oldIndex);
            if(copyPageData) {
                newPage.set("data", oldData);
            }

            that.removePageEntry(oldPage);
            that.addPageEntry(newPage);
        };

        this.routeToPageEntry = function (page, navigateToPage, deferredNavigation) {
            var pagesToRemove = [];
            // Remove all indexes that comes after page
            for(var index = page.get("index") + 1; index < this.breadcrumbs.size(); index++) {
                var pageToRemove = this.breadcrumbs.models[index];
                pagesToRemove.push(pageToRemove);
            }

            that.removePageEntries(pagesToRemove);

            // marking entry as back navigation - since clicking on an entry before, is like going back in navigation a few more steps
            page.set("backNavigation", true);

            if (navigateToPage) {
                var router = common.util.ObjectUtils.getFirstElementValue(that.routers);

                if(deferredNavigation) {
                    _.defer(function () {
                        // when doing browser back - the router object is not created
                        // so we need to check here for not null
                        if (router != null) {
                            router.navigate(page.get("url"), {trigger: true, replace: true});
                        }
                    });
                } else {
                    router.navigate(page.get("url"), {trigger: true, replace: true});
                }


                // if it's a different page, requires refresh & browser supports push state
                var pageUrl = page.get("url");
                if (pageUrl.indexOf(application.getPageContextPath()) === -1
                    && application.getPageContextPath().indexOf(pageUrl) === -1
                    && "pushState" in window.history) {

                    window.location.reload();
                }
            }
        };

        this.getCurrentPage = function () {
            if(this.breadcrumbs.size() > 0) {
                return this.breadcrumbs.last();
            }
            return null;
        };

        /**
         * Persist data into page entry custom data map.
         * If not specifying a page, currentPage will be used.
         *
         * @param key
         * @param value
         * @param [page]
         */
        this.putDataToPage = function (key, value, page) {
            // current page will be used on default
            if(!page)
                page = that.getCurrentPage();

            if (page != null) {
                var pageData = page.get("data");
                pageData[key] = value;

                // Update the page's cookie
                var cookieKey = that.COOKIE_PREFIX_FORMAT.format(page.get("index"));
                this.storageApi.setItem(cookieKey, page.toJSON());
            }
        };

        this.getCurrentPageData = function (key) {
            var value = null;

            var currentPage = that.getCurrentPage();
            if (currentPage != null && !_.isEmpty(key)) {
                var pageData = currentPage.get("data");
                value = pageData[key];
            }
            return value;
        };

        this.back = function () {
            var numberOfEntries = this.breadcrumbs.size();

            if (numberOfEntries > 1) {
                var oneBeforeLast = this.breadcrumbs.models[numberOfEntries - 2];
                this.routeToPageEntry(oneBeforeLast, true);
            }
        };

        this.removeLastPageEntry = function () {
            var numberOfEntries = this.breadcrumbs.size();

            if (numberOfEntries > 1) {
                var oneBeforeLast = this.breadcrumbs.models[numberOfEntries - 2];
                this.routeToPageEntry(oneBeforeLast, false);
            }
        };

        this.isBackNavigation = function () {
            var backNavigation = false;
            var currentPage = that.getCurrentPage();

            if (currentPage != null && currentPage.has("backNavigation")) {
                backNavigation = currentPage.get("backNavigation");
            }
            return backNavigation;
        };

        this.checkBreadcrumbsTail = function () {
            if(this.breadcrumbs.size() > this.maxPageEntries) {
                // Remove all cookies/storage
                for (var i = 0; i < this.breadcrumbs.length; i++) {
                    var cookieKeyToRemove = that.COOKIE_PREFIX_FORMAT.format(i);
                    this.storageApi.removeItem(cookieKeyToRemove);
                }

                // cut the breadcrumbs tail
                this.breadcrumbs.shift();

                // update all pages indexes
                for (var j = 0; j < this.breadcrumbs.length; j++) {
                    var pageEntry = this.breadcrumbs.models[j];
                    pageEntry.set("index", j);

                    var cookieKeyToSet = that.COOKIE_PREFIX_FORMAT.format(j);
                    this.storageApi.setItem(cookieKeyToSet, pageEntry.toJSON());
                }
            }
        };

        // check if user tried to do a back with browser
        this._checkBackNavigationFromBrowser();
    };

    Backbone.Navigation = Navigation;
});
