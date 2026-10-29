// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CrowdFundingLedger
 * @notice Ethereum Smart Contract for Blockchain-Ledger Based Crowdfunding & Inventory Management.
 * Implements immutable project verification, inventory tracking, financial escrow, and tamper freeze.
 */
contract CrowdFundingLedger {
    address public admin;

    struct InventoryRecord {
        string itemId;
        string itemName;
        uint256 quantity;
        uint256 unitPrice;
        string action;
        uint256 timestamp;
    }

    struct DocumentRecord {
        string documentName;
        string sha256Checksum;
        uint256 timestamp;
        address verifiedBy;
    }

    struct Project {
        string id;
        string title;
        address manager;
        uint256 targetFunding;
        uint256 currentFunding;
        uint256 tenureMonths;
        bool isVerified;
        bool isSuspended; // True if ledger tamper detected or admin freezes
        string suspensionReason;
        uint256 createdAt;
    }

    // Storage
    string[] public projectIds;
    mapping(string => Project) public projects;
    mapping(string => bool) public projectExists;
    mapping(string => mapping(address => uint256)) public investorBalances; // projectId => investor => balance
    mapping(string => InventoryRecord[]) public projectInventory;
    mapping(string => DocumentRecord[]) public projectDocuments;

    // Events
    event ProjectProposed(string indexed projectId, string title, address indexed manager, uint256 targetFunding, uint256 tenureMonths);
    event ProjectVerified(string indexed projectId, address indexed admin);
    event InvestmentLogged(string indexed projectId, address indexed investor, uint256 amount, uint256 totalFunding);
    event WithdrawalLogged(string indexed projectId, address indexed investor, uint256 amount);
    event InventoryLogged(string indexed projectId, string itemName, uint256 quantity, string action, uint256 timestamp);
    event DocumentAnchored(string indexed projectId, string documentName, string sha256Checksum, address verifiedBy);
    event ProjectFrozen(string indexed projectId, string reason);
    event ProjectUnfrozen(string indexed projectId);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Caller is not platform administrator");
        _;
    }

    modifier onlyVerifiedAndActive(string memory _projectId) {
        require(projectExists[_projectId], "Project does not exist");
        require(projects[_projectId].isVerified, "Project has not been admin verified");
        require(!projects[_projectId].isSuspended, "Security Alert: Project investment suspended due to ledger lock");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    /**
     * @notice Manager proposes a new crowdfunding campaign on-chain
     */
    function proposeProject(
        string calldata _id,
        string calldata _title,
        uint256 _targetFunding,
        uint256 _tenureMonths
    ) external {
        require(!projectExists[_id], "Project ID already registered");
        require(_targetFunding > 0, "Target funding must be greater than zero");
        require(_tenureMonths > 0, "Tenure must be positive");

        projects[_id] = Project({
            id: _id,
            title: _title,
            manager: msg.sender,
            targetFunding: _targetFunding,
            currentFunding: 0,
            tenureMonths: _tenureMonths,
            isVerified: false,
            isSuspended: false,
            suspensionReason: "",
            createdAt: block.timestamp
        });

        projectIds.push(_id);
        projectExists[_id] = true;

        emit ProjectProposed(_id, _title, msg.sender, _targetFunding, _tenureMonths);
    }

    /**
     * @notice Admin verifies project genuity based on submitted documentation
     */
    function verifyProject(string calldata _projectId) external onlyAdmin {
        require(projectExists[_projectId], "Project not found");
        Project storage p = projects[_projectId];
        p.isVerified = true;

        emit ProjectVerified(_projectId, msg.sender);
    }

    /**
     * @notice Anchors cryptographic SHA-256 hash of verification documents onto Ethereum
     */
    function anchorDocument(
        string calldata _projectId,
        string calldata _documentName,
        string calldata _sha256Checksum
    ) external onlyAdmin {
        require(projectExists[_projectId], "Project not found");

        projectDocuments[_projectId].push(DocumentRecord({
            documentName: _documentName,
            sha256Checksum: _sha256Checksum,
            timestamp: block.timestamp,
            verifiedBy: msg.sender
        }));

        emit DocumentAnchored(_projectId, _documentName, _sha256Checksum, msg.sender);
    }

    /**
     * @notice Logs equipment and inventory bill-of-materials on the immutable ledger
     */
    function recordInventoryChange(
        string calldata _projectId,
        string calldata _itemId,
        string calldata _itemName,
        uint256 _quantity,
        uint256 _unitPrice,
        string calldata _action
    ) external {
        require(projectExists[_projectId], "Project not found");
        require(
            msg.sender == admin || msg.sender == projects[_projectId].manager,
            "Only admin or project manager can log inventory"
        );

        projectInventory[_projectId].push(InventoryRecord({
            itemId: _itemId,
            itemName: _itemName,
            quantity: _quantity,
            unitPrice: _unitPrice,
            action: _action,
            timestamp: block.timestamp
        }));

        emit InventoryLogged(_projectId, _itemName, _quantity, _action, block.timestamp);
    }

    /**
     * @notice Investor contributes funds to project (locked if tampered or suspended)
     */
    function invest(string calldata _projectId) external payable onlyVerifiedAndActive(_projectId) {
        require(msg.value > 0, "Investment value must be greater than zero");
        Project storage p = projects[_projectId];

        p.currentFunding += msg.value;
        investorBalances[_projectId][msg.sender] += msg.value;

        emit InvestmentLogged(_projectId, msg.sender, msg.value, p.currentFunding);
    }

    /**
     * @notice Allows withdrawal of investor capital / returns
     */
    function withdraw(string calldata _projectId, uint256 _amount) external {
        require(projectExists[_projectId], "Project not found");
        require(investorBalances[_projectId][msg.sender] >= _amount, "Insufficient invested balance");
        require(!projects[_projectId].isSuspended, "Withdrawals suspended while ledger is under audit");

        investorBalances[_projectId][msg.sender] -= _amount;
        projects[_projectId].currentFunding -= _amount;

        (bool success, ) = payable(msg.sender).call{value: _amount}("");
        require(success, "ETH transfer failed");

        emit WithdrawalLogged(_projectId, msg.sender, _amount);
    }

    /**
     * @notice Security protocol: Halts all investment activity on detection of unauthorized ledger tampering
     */
    function freezeProject(string calldata _projectId, string calldata _reason) external onlyAdmin {
        require(projectExists[_projectId], "Project not found");
        Project storage p = projects[_projectId];
        p.isSuspended = true;
        p.suspensionReason = _reason;

        emit ProjectFrozen(_projectId, _reason);
    }

    /**
     * @notice Restores project funding activity after ledger verification
     */
    function unfreezeProject(string calldata _projectId) external onlyAdmin {
        require(projectExists[_projectId], "Project not found");
        Project storage p = projects[_projectId];
        p.isSuspended = false;
        p.suspensionReason = "";

        emit ProjectUnfrozen(_projectId);
    }

    // View helper getters
    function getInventoryCount(string calldata _projectId) external view returns (uint256) {
        return projectInventory[_projectId].length;
    }

    function getDocumentsCount(string calldata _projectId) external view returns (uint256) {
        return projectDocuments[_projectId].length;
    }

    function getProjectList() external view returns (string[] memory) {
        return projectIds;
    }
}
