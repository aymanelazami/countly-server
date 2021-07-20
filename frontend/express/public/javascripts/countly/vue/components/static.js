/* global app, jQuery, CV, Vue, countlyGlobal, _*/

(function(countlyVue, $) {

    $(document).ready(function() {

        var SidebarOptions = countlyVue.views.create({
            template: CV.T('/javascripts/countly/vue/templates/sidebar/sidebar-options.html'),
            props: {
                selected: {
                    type: String,
                    default: "analytics"
                },
                mainOptions: {
                    type: Array,
                    default: function() {
                        return [];
                    }
                },
                otherOptions: {
                    type: Array,
                    default: function() {
                        return [];
                    }
                }
            },
            data: function() {
                return {
                    selectedOption: this.selected
                };
            },
            methods: {
                onClick: function(option, e) {
                    if (!option.noSelect) {
                        this.selectedOption = option.name;
                    }

                    this.$emit("click", option, e);
                }
            }
        });

        var AnalyticsMenu = countlyVue.views.create({
            template: CV.T('/javascripts/countly/vue/templates/sidebar/analytics-menu.html'),
            mixins: [
                countlyVue.container.dataMixin({
                    "categories": "/sidebar/analytics/menuCategory",
                    "menus": "/sidebar/analytics/menu",
                    "submenus": "/sidebar/analytics/submenu"
                })
            ],
            data: function() {
                var apps = _.sortBy(countlyGlobal.apps, function(app) {
                    return (app.name + "").toLowerCase();
                });

                apps = apps.map(function(a) {
                    a.label = a.name;
                    a.value = a._id;

                    return a;
                });

                return {
                    allApps: apps,
                    selectMode: "single-list",
                    selectedAppLocal: null
                };
            },
            computed: {
                selectedApp: {
                    get: function() {
                        var activeApp = this.$store.getters["countlyCommon/getActiveApp"];

                        if (!this.selectedAppLocal) {
                            if (!activeApp) {
                                // eslint-disable-next-line no-undef
                                // console.log("sidebar:: active app not set");
                            }

                            this.selectedAppLocal = activeApp && activeApp._id;
                        }

                        return this.selectedAppLocal;
                    },
                    set: function(id) {
                        this.selectedAppLocal = id;
                    }
                },
                activeApp: function() {
                    var selectedAppId = this.selectedApp;
                    var active = this.allApps.find(function(a) {
                        return a._id === selectedAppId;
                    });

                    if (active) {
                        active.image = countlyGlobal.path + "appimages/" + active._id + ".png";
                    }

                    return active || {};
                },
                categorizedMenus: function() {
                    if (!this.activeApp) {
                        return {};
                    }
                    var self = this;
                    var menus = this.menus.reduce(function(acc, val) {
                        if (val.app_type === self.activeApp.type) {
                            (acc[val.category] = acc[val.category] || []).push(val);
                        }
                        return acc;
                    }, {});
                    return menus;
                },
                categorizedSubmenus: function() {
                    if (!this.activeApp) {
                        return {};
                    }
                    var self = this;
                    var submenus = this.submenus.reduce(function(acc, val) {
                        if (val.app_type === self.activeApp.type) {
                            (acc[val.parent_code] = acc[val.parent_code] || []).push(val);
                        }
                        return acc;
                    }, {});
                    return submenus;
                }
            },
            methods: {
                onChange: function(id) {
                    var selectedApp = this.allApps.find(function(a) {
                        return a._id === id;
                    });

                    var appKey = selectedApp.key;
                    var appName = selectedApp.name;
                    var appId = selectedApp._id;
                    if (app.activeAppKey !== appKey) {
                        app.activeAppName = appName;
                        app.activeAppKey = appKey;
                        app.switchApp(appId);
                    }
                },
                suffixIconClass: function(dropdown) {
                    return (dropdown.visible ? 'arrow-up is-reverse' : 'arrow-up');
                }
            }
        });

        var ManagementMenu = countlyVue.views.create({
            template: CV.T('/javascripts/countly/vue/templates/sidebar/management-menu.html'),
            mixins: [
                countlyVue.container.dataMixin({
                    "menus": "/sidebar/analytics/menu"
                })
            ],
            computed: {
                menu: function() {
                    var menu = this.menus.filter(function(val) {
                        if (val.category === "management") {
                            return true;
                        }
                        return false;
                    });
                    return menu;
                },
            }
        });

        var UsersMenu = countlyVue.views.create({
            template: CV.T('/javascripts/countly/vue/templates/sidebar/users-menu.html'),
            data: function() {
                return {
                    visible: true
                };
            },
            computed: {
                member: function() {
                    var userImage = {};
                    var member = JSON.parse(JSON.stringify(countlyGlobal.member));
                    if (member) {
                        userImage.url = member.member_image;
                        userImage.found = true;
                    }
                    else {
                        var defaultAvatarSelector = (member.created_at || Date.now()) % 16 * 30;
                        var name = member.full_name.split(" ");

                        userImage.found = false;
                        userImage.url = "images/avatar-sprite.png";
                        userImage.position = defaultAvatarSelector;
                        userImage.initials = name[0][0] + name[name.length - 1][0];
                    }

                    member.image = userImage;

                    return member;
                }
            },
            methods: {
                clickOutside: function() {
                    this.visible = false;
                }
            }
        });

        var SidebarView = countlyVue.views.create({
            template: CV.T('/javascripts/countly/vue/templates/sidebar/sidebar.html'),
            mixins: [
                countlyVue.container.dataMixin({
                    "externalMainOptions": "/sidebar/options/main",
                    "externalOtherOptions": "/sidebar/options/other"
                })
            ],
            components: {
                "sidebar-options": SidebarOptions,
                "users-menu": UsersMenu
            },
            data: function() {
                return {
                    selectedOption: "analytics",
                    noSelectOption: "",
                    position: {
                        x: 0,
                        y: 0
                    }
                };
            },
            computed: {
                components: function() {
                    var options = [
                        {
                            name: "analytics",
                            component: AnalyticsMenu
                        },
                        {
                            name: "management",
                            component: ManagementMenu
                        }
                    ];

                    var externalMainOptions = this.externalMainOptions;
                    var externalOtherOptions = this.externalOtherOptions;

                    if (externalMainOptions && externalMainOptions.length) {
                        options = options.concat(externalMainOptions);
                    }

                    if (externalOtherOptions && externalOtherOptions.length) {
                        options = options.concat(externalOtherOptions);
                    }

                    return options;
                },
                mainOptions: function() {
                    var options = [
                        {
                            name: "app",
                            noSelect: true
                        },
                        {
                            name: "search",
                            icon: "ion-ios-search-strong"
                        },
                        {
                            name: "analytics",
                            icon: "ion-stats-bars"
                        },
                        {
                            name: "divider",
                            noSelect: true
                        },
                        {
                            name: "management",
                            icon: "ion-wrench"
                        }
                    ];

                    var externalMainOptions = this.externalMainOptions;

                    if (externalMainOptions && externalMainOptions.length) {
                        for (var i = 0; i < externalMainOptions.length; i++) {
                            options.splice(3, 0, externalMainOptions[i]);
                        }
                    }

                    return options;
                },
                otherOptions: function() {
                    var options = [
                        {
                            name: "clipboard",
                            icon: "ion-clipboard",
                            noSelect: true
                        },
                        {
                            name: "notifications",
                            icon: "ion-android-notifications",
                            noSelect: true
                        },
                        {
                            name: "user",
                            icon: "ion-person",
                            noSelect: true,
                        },
                        {
                            name: "toggle",
                            icon: "ion-chevron-left",
                            noSelect: true
                        }
                    ];

                    var externalOtherOptions = this.externalOtherOptions;

                    if (externalOtherOptions && externalOtherOptions.length) {
                        for (var i = 0; i < externalOtherOptions.length; i++) {
                            options.splice(3, 0, externalOtherOptions[i]);
                        }
                    }

                    return options;
                }
            },
            methods: {
                onClick: function(option, e) {
                    if (!option.noSelect) {
                        this.selectedOption = option.name;
                        this.noSelectOption = "";
                        this.position.x = 0;
                        this.position.y = 0;
                    }
                    else {
                        this.noSelectOption = option.name;
                        this.position.x = e.clientX;
                        this.position.y = e.clientY;
                    }
                }
            }
        });

        new Vue({
            el: $('#sidebar-x').get(0),
            store: countlyVue.vuex.getGlobalStore(),
            components: {
                Sidebar: SidebarView
            },
            template: '<Sidebar></Sidebar>'
        });
    });

}(window.countlyVue = window.countlyVue || {}, jQuery));
