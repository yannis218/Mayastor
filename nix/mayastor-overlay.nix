self: super: {

  terraform-provider-lxd = super.callPackage ./pkgs/terraform-provider-lxd { };
  libiscsi = super.callPackage ./pkgs/libiscsi { };
  liburing = super.callPackage ./pkgs/liburing { };
  nvme-cli = super.callPackage ./pkgs/nvme-cli { };
  nvmet-cli = super.callPackage ./pkgs/nvmet-cli { };
  libspdk = super.callPackage ./pkgs/libspdk { };
  mayastor = (super.callPackage ./pkgs/mayastor { }).mayastor;
  mayastorImage = (super.callPackage ./pkgs/mayastor { }).mayastorImage;
  mayastorCSIImage = (super.callPackage ./pkgs/mayastor { }).mayastorCSIImage;
  ms-buildenv = super.callPackage ./pkgs/ms-buildenv { };
  mkContainerEnv = super.callPackage ./lib/mkContainerEnv.nix { };
  node-moac = (import ./../csi/moac { pkgs = super; }).package;
  node-moacImage = (import ./../csi/moac { pkgs = super; }).buildImage;
  nodePackages = (import ./pkgs/nodePackages { pkgs = super; });
}
